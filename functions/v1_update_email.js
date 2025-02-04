const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks for all functions
async function initialize_and_check(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    const { uid, email } = req.body;
    if (!uid || !email) {
        res.status(400).send("Missing required parameters");
        return { proceed: false };
    }

    // Validate email format
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.status(400).send("Invalid email format");
        return { proceed: false };
    }

    // Extract and verify Firebase Auth Token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        console.error(`Error verifying token: ${error.message}`);
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the request UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    // Check the actions document for rate limiting
    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        total_actions_today += 1;
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, email };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_update_email = functions.https.onRequest(async (req, res) => {
    const init_result = await initialize_and_check(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { uid, email } = init_result;
    const user_ref = admin.firestore().collection('users').doc(uid);

    try {
        console.log(`Starting v1_update_email function for uid: ${uid}`);

        await admin.firestore().runTransaction(async (transaction) => {
            const user_doc = await transaction.get(user_ref);
            if (!user_doc.exists) {
                throw new Error('User document does not exist.');
            }

            const userData = user_doc.data();
            console.log(`Document data: ${JSON.stringify(userData)}`);

            if (userData.general?.uid !== uid) {
                throw new Error('UID mismatch in user document general.uid field.');
            }

            transaction.update(user_ref, {
                "general.email": email
            });
        });

        res.status(200).send({ status: "success", message: "User email updated successfully", email, documentId: uid });
    } catch (error) {
        console.error(`Error in v1_update_email function for uid: ${uid}: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});

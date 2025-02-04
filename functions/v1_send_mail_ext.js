const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight request
    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    // Ensure request method is POST
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    const { uid } = req.body;

    // Check if UID is provided
    if (!uid) {
        res.status(400).send("Missing required parameter: uid");
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

    try {
        // Fetch user record and check custom claims
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // Fetch user's action document to check limits
        const actions_ref = admin.firestore().collection('actions').doc(uid);
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        // Convert Firestore timestamp to JavaScript Date
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        // Check if 24 hours have passed since the last reset
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            // Reset daily action count
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if user exceeded daily action limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

// Function to send email
module.exports.v1_send_mail_ext = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    // Extract required parameters from request body
    const { uid, to, subject, html, type } = req.body;

    // Validate input parameters
    if (!to || !subject || !html || !type) {
        res.status(400).send("Missing required parameters: 'to', 'subject', 'html', and 'type'");
        return;
    }

    try {
        // Store email request in Firestore `mail` collection
        const mailRef = admin.firestore().collection('mail').doc();
        await mailRef.set({
            uid,
            type, // Storing the new 'type' key
            to,
            message: {
                subject,
                html
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).send({ status: "success", message: "Email request submitted successfully" });
    } catch (error) {
        console.error(`Error sending email: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});


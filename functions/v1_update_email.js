// Firebase Cloud Function: v1_update_email.js
const functions = require('firebase-functions');
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

    // Extract necessary parameters from the request body
    const { uid, email } = req.body;

    if (!uid || !email) {
        res.status(400).send("Missing required parameters");
        return { proceed: false };
    }

    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.status(400).send("Invalid email format");
        return { proceed: false };
    }

    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // General action check before proceeding
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
            // Reset total_actions_today and update reset_global_action_at
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if the user has exceeded the daily limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;

        // Update the actions document with the new values
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

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Retrieve the user's document using 'uid'
            const user_doc = await transaction.get(user_ref);
            if (!user_doc.exists) {
                throw new Error('User document does not exist.');
            }

            // Update the email field in the user's document
            transaction.update(user_ref, {
                "general.email": email
            });
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "User email updated successfully", email });
    } catch (error) {
        console.error(`Error in v1_update_email function for uid: ${uid}: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

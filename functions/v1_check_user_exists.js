const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1_check_user_exists = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return;
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
    }

    const { email } = req.body;

    if (!email) {
        console.error("Missing required parameter: 'email'.");
        res.status(400).send("Missing required parameter: 'email'.");
        return;
    }

    try {
        // Check if the user exists in Firebase Authentication
        const userRecord = await admin.auth().getUserByEmail(email);
        console.log("User found:", userRecord);

        res.status(200).send({
            status: "success",
            user_exists: "true",
            message: "User exists.",
            data: {
                uid: userRecord.uid,
                email: userRecord.email,
                emailVerified: userRecord.emailVerified,
                displayName: userRecord.displayName,
                disabled: userRecord.disabled
            }
        });
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            console.log("User not found for email:", email);
            res.status(200).send({
                status: "not_found",
                user_exists: "false",
                message: "User does not exist.",
                data: {
                    email
                }
            });
        } else {
            console.error("Error checking user existence:", error);
            res.status(500).send({
                status: "error",
                user_exists: "false",
                message: error.message
            });
        }
    }
});

// Firebase Cloud Function: v1UserStatusUpdate.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1UserStatusUpdate = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowedOrigin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    // Extract necessary parameters from the request body
    const { uid, userStatus } = req.body;

    if (!uid || !userStatus) {
        return res.status(400).send("Missing required parameters");
    }

    const userRef = admin.firestore().collection('users').doc(uid);

    try {
        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Retrieve the user's document using 'uid'
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User document does not exist.');
            }

            // Update the userStatus field in the user's document
            transaction.update(userRef, {
                "general.userStatus": userStatus
            });
        });

        // Update the custom claims for the user
        await admin.auth().setCustomUserClaims(uid, {
            userStatus: userStatus
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "User status updated successfully", userStatus });
    } catch (error) {
        console.error(`Error in v1UserStatusUpdate function: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

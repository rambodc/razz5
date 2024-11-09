// Firebase Cloud Function: v1lastResetTime.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1lastResetTime = functions.https.onRequest(async (req, res) => {
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
    const { uid, lastResetTime, dailyRaz } = req.body;

    if (!uid || lastResetTime === undefined || dailyRaz === undefined) {
        return res.status(400).send("Missing required parameters");
    }

    const userRef = admin.firestore().collection('users').doc(uid);

    try {
        // Verify custom claims for the user
        const userRecord = await admin.auth().getUser(uid);
        const customClaims = userRecord.customClaims;
        if (!customClaims || customClaims.userType !== 'user' || customClaims.userStatus !== 'active') {
            return res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
        }

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Retrieve the user's document using 'uid'
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User document does not exist.');
            }

            // Update the lastResetTime and dailyRaz fields in the user's document
            transaction.update(userRef, {
                "general.lastResetTime": lastResetTime,
                "general.dailyRaz": dailyRaz
            });
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "User reset time updated successfully", lastResetTime, dailyRaz });
    } catch (error) {
        console.error(`Error in v1lastResetTime function: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

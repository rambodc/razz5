const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1_signup_code1_check = functions.https.onRequest(async (req, res) => {
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
        res.status(405).send({ status: "error", message: "Method Not Allowed" });
        return;
    }

    const { doc_id, code, to } = req.body;

    if (!doc_id || !code || !to) {
        console.error("Missing required parameters: 'doc_id', 'code', or 'to'.");
        res.status(400).send({ status: "error", message: "Missing required parameters: 'doc_id', 'code', or 'to'." });
        return;
    }

    try {
        console.log("Checking 'codes' collection for match...");

        // Fetch the document from the 'codes' collection
        const codeDoc = await admin.firestore().collection('codes').doc(doc_id).get();

        if (!codeDoc.exists) {
            console.error("Code document not found.");
            res.status(404).send({ status: "error", message: "Code not found." });
            return;
        }

        const codeData = codeDoc.data();

        // Check if the code is already validated
        if (codeData.validated) {
            console.error("Code has already been validated.");
            res.status(400).send({ status: "error", message: "Code has already been validated." });
            return;
        }

        // Validate the code, recipient, and expiration
        if (codeData.code !== code) {
            console.error("Invalid code.");
            res.status(400).send({ status: "error", message: "Invalid code." });
            return;
        }

        if (codeData.to !== to) {
            console.error("Recipient does not match.");
            res.status(400).send({ status: "error", message: "Recipient does not match." });
            return;
        }

        const now = admin.firestore.Timestamp.now();
        if (codeData.expires_at.toMillis() < now.toMillis()) {
            console.error("Code has expired.");
            res.status(400).send({ status: "error", message: "Code has expired." });
            return;
        }

        // Mark the code as validated
        await admin.firestore().collection('codes').doc(doc_id).update({
            validated: true
        });

        console.log("Code is valid, not expired, and marked as validated.");
        res.status(200).send({
            status: "success",
            message: "Code is valid and has been validated.",
            data: { doc_id, code, to }
        });
    } catch (error) {
        console.error("Error checking code:", error);
        res.status(500).send({ status: "error", message: error.message });
    }
});

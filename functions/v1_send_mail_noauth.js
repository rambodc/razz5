const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1_send_mail_noauth = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return;
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
    }

    const { to, subject, html, type } = req.body;

    if (!to || !subject || !html || !type) {
        console.error("Missing required parameters: 'to', 'subject', 'html', or 'type'.");
        res.status(400).send("Missing required parameters: 'to', 'subject', 'html', or 'type'.");
        return;
    }

    try {
        // Write email data to Firestore 'mail' collection
        const mailRef = admin.firestore().collection('mail').doc();
        console.log("Writing to 'mail' collection...");
        await mailRef.set({
            to,
            message: {
                subject,
                html
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("Mail document written successfully.");

        res.status(200).send({
            status: "success",
            message: "Email queued successfully.",
            document_id: mailRef.id
        });
    } catch (error) {
        console.error("Error writing email to Firestore:", error);
        res.status(500).send({ status: "error", message: error.message });
    }
});

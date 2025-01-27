const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Utility function to generate a 6-digit code
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports.v1_signup_code1 = functions.https.onRequest(async (req, res) => {
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

    const { to, subject, html, type } = req.body;

    if (!to || !subject || !html || !type) {
        console.error("Missing required parameters: 'to', 'subject', 'html', or 'type'.");
        res.status(400).send("Missing required parameters: 'to', 'subject', 'html', or 'type'.");
        return;
    }

    try {
        // Generate a 6-digit code
        const code = generateCode();
        console.log("Generated code:", code);

        // Write code to Firestore 'codes' collection
        const codesRef = admin.firestore().collection('codes').doc();
        const docId = codesRef.id;
        console.log("Writing to 'codes' collection...");
        const expires_at = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)); // 1-hour expiry

        await codesRef.set({
            code,
            to,
            type,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            expires_at
        });
        console.log("Code written successfully.");

        // Replace the placeholder in the HTML with the generated code using a better placeholder format
        const customizedHtml = html.replace(/\{\{CODE\}\}/g, code);
        console.log("Customized HTML:", customizedHtml);

        // Write email data to Firestore 'mail' collection
        const mailRef = admin.firestore().collection('mail').doc();
        console.log("Writing to 'mail' collection...");
        await mailRef.set({
            to,
            message: {
                subject,
                html: customizedHtml
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("Mail document written successfully.");

        res.status(200).send({
            status: "success",
            message: "Signup code generated and email sent successfully.",
            data: {
                code,
                expires_at,
                to,
                type,
                document_id: docId
            }
        });
    } catch (error) {
        console.error("Error during signup code generation and email sending:", error);
        res.status(500).send({ status: "error", message: error.message });
    }
});

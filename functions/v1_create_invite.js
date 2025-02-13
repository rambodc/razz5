const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1_create_invite = functions.https.onRequest(async (req, res) => {
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
        res.status(405).send({ status: "error", message: "Method Not Allowed" });
        return;
    }

    const { email, type, metadata } = req.body;

    if (!email || !type) {
        console.error("Missing required parameters: 'email' or 'type'.");
        res.status(400).send({ status: "error", message: "Missing required parameters: 'email' or 'type'." });
        return;
    }

    try {
        console.log("Creating a new invite document...");

        const inviteRef = await admin.firestore().collection('invites').add({
            general: {
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                email,
                type,
                invite_id: "" // Placeholder for Firestore-generated ID
            },
            metadata: metadata || {} // Store metadata as an object
        });

        // Update the document to store the generated ID as invite_id
        await inviteRef.update({ 'general.invite_id': inviteRef.id });

        console.log("Invite created successfully with ID:", inviteRef.id);

        res.status(200).send({
            status: "success",
            message: "Invite created successfully.",
            data: {
                general: {
                    invite_id: inviteRef.id,
                    email,
                    type,
                    created_at: new Date().toISOString() // This will be the client-side representation
                },
                metadata: metadata || {}
            }
        });
    } catch (error) {
        console.error("Error creating invite:", error);
        res.status(500).send({ status: "error", message: error.message });
    }
});

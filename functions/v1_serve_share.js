const functions = require('firebase-functions');
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud Storage with project ID from environment variables
const storage = new Storage({ projectId: functions.config().project_id });

exports.v1_serve_share = functions.https.onRequest(async (req, res) => {
    const shareId = req.path.split('/').pop();

    if (!shareId) {
        return res.status(400).send("Invalid share ID");
    }

    const bucketName = functions.config().storage.bucket;
    const filePath = `share/${shareId}/index.html`;
    const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filePath)}?alt=media`;

    try {
        // Check if the file exists in Cloud Storage (optional validation)
        const [exists] = await storage.bucket(bucketName).file(filePath).exists();

        if (!exists) {
            return res.status(404).send("Share not found");
        }

        // Redirect to the Firebase Storage URL
        return res.redirect(302, firebaseUrl);
    } catch (error) {
        console.error("Error serving share file:", error.message);
        return res.status(500).send("Internal Server Error");
    }
});

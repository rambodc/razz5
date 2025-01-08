const functions = require('firebase-functions');
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud Storage with project ID from environment variables
const storage = new Storage({ projectId: functions.config().project_id });

exports.v1_serve_share = functions.https.onRequest(async (req, res) => {
    // Extract the share ID from the URL path
    const shareId = req.path.split('/').pop();

    if (!shareId) {
        return res.status(400).send("Invalid share ID");
    }

    const bucketName = functions.config().storage.bucket;
    const filePath = `share/${shareId}/index.html`;
    const fileUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

    try {
        // Check if the file exists in Cloud Storage (optional for validation)
        const [exists] = await storage.bucket(bucketName).file(filePath).exists();

        if (!exists) {
            return res.status(404).send("Share not found");
        }

        // Redirect to the Cloud Storage URL
        return res.redirect(302, fileUrl);
    } catch (error) {
        console.error("Error serving share file:", error.message);
        return res.status(500).send("Internal Server Error");
    }
});

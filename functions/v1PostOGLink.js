// Firebase Cloud Function: v1PostOGLink.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Initialize Google Cloud Storage
const storage = new Storage();

module.exports.v1PostOGLink = functions.https.onRequest(async (req, res) => {
    const postId = req.params[0].replace('post/', '');
    if (!postId) {
        return res.status(400).send("Missing postId in the URL");
    }

    try {
        console.log(`Starting v1PostOGLink function for postId: ${postId}`);

        // Retrieve the Open Graph storage URL based on postId
        const storageBucket = functions.config().storage.bucket;
        const filePath = `posts/${postId}/og/index.html`;
        const bucket = storage.bucket(storageBucket);
        const file = bucket.file(filePath);

        // Read the HTML content from the file
        const [fileContent] = await file.download();

        // Set appropriate headers to ensure the response is treated as HTML
        res.set('Content-Type', 'text/html');
        res.status(200).send(fileContent);
    } catch (error) {
        console.error(`Error in v1PostOGLink function for postId: ${postId}: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});

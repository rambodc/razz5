// Firebase Cloud Function: v1PostOGLink.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1PostOGLink = functions.https.onRequest(async (req, res) => {
    const postId = req.params[0];
    if (!postId) {
        return res.status(400).send("Missing postId in the URL");
    }

    try {
        console.log(`Starting v1PostOGLink function for postId: ${postId}`);

        // Retrieve the Open Graph storage URL based on postId
        const storageBucket = functions.config().storage.bucket;
        const storageUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucket}/o/posts%2F${postId}%2Fog%2Findex.html?alt=media`;

        // Redirect to the storage URL
        return res.redirect(301, storageUrl);
    } catch (error) {
        console.error(`Error in v1PostOGLink function for postId: ${postId}: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

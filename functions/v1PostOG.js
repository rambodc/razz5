// Firebase Cloud Function: v1PostOG.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Initialize Google Cloud Storage with project ID from environment variables
const storage = new Storage({ projectId: functions.config().project_id });

module.exports.v1PostOG = functions.https.onRequest(async (req, res) => {
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
    const { postId, title, description, image, ogUrl, redirectUrl, refresh } = req.body;

    if (!postId || !title || !description || !image || !ogUrl || !redirectUrl || refresh === undefined) {
        return res.status(400).send("Missing required parameters");
    }

    const postDocRef = admin.firestore().collection('posts').doc(postId);

    try {
        console.log(`Starting v1PostOG function for postId: ${postId}`);

        // Get the server timestamp
        const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

        // Step 1: Transaction to update the post document with the OG object
        await admin.firestore().runTransaction(async (transaction) => {
            const postDoc = await transaction.get(postDocRef);

            if (!postDoc.exists) {
                throw new Error(`Post with postId: ${postId} does not exist.`);
            }

            const ogData = {
                title,
                description,
                image,
                ogUrl,
                redirectUrl,
                refresh,
                updatedAt: serverTimestamp
            };

            // Update the post document with the Open Graph data
            transaction.update(postDocRef, { og: ogData });

            console.log(`Open Graph data added to post document for postId: ${postId}`);
        });

        // Step 2: Create an index.html page with Open Graph and Twitter metadata and a redirect
        const indexHtmlContent = `
        <html>
          <head>
            <!-- Open Graph Metadata -->
            <meta property="og:title" content="${title}" />
            <meta property="og:description" content="${description}" />
            <meta property="og:image" content="${image}" />
            <meta property="og:url" content="${ogUrl}" />

            <!-- Twitter Card Metadata -->
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="${title}" />
            <meta name="twitter:description" content="${description}" />
            <meta name="twitter:image" content="${image}" />
            <meta name="twitter:url" content="${ogUrl}" />

            <!-- Redirect to your SPA URL after ${refresh} seconds -->
            <meta http-equiv="refresh" content="${refresh}; url=${redirectUrl}" />

            <!-- Page Style for Background Color and Centering Text -->
            <style>
              body {
                background-color: #d0d3db;
                color: black;
                font-family: Arial, sans-serif;
                height: 100vh;
                margin: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                text-align: center;
                flex-direction: column;
              }

              h1 {
                margin: 0;
                font-size: 2.5em;
              }

              p {
                margin: 0;
                font-size: 1.5em;
              }
            </style>
          </head>
          <body>
            <h1>Razzberry</h1>
            <p>Loading...</p>
          </body>
        </html>
        `;

        // Step 3: Write the HTML content to a local temporary file
        const tempFilePath = path.join(os.tmpdir(), 'index.html');
        fs.writeFileSync(tempFilePath, indexHtmlContent, 'utf8');

        // Define the full bucket name and file path in Cloud Storage (posts/${postId}/og/index.html)
        const fullBucketName = functions.config().storage.bucket;
        const bucket = storage.bucket(fullBucketName);
        const destinationPath = `posts/${postId}/og/index.html`;

        // Step 4: Upload the index.html file to Cloud Storage
        await bucket.upload(tempFilePath, {
            destination: destinationPath,
            metadata: {
                contentType: 'text/html'
            }
        });

        console.log(`index.html uploaded to: ${destinationPath}`);

        // Cleanup: Remove the temporary file
        fs.unlinkSync(tempFilePath);

        // Respond with success message
        return res.status(200).send({ status: "success", message: "Open Graph page created successfully", postId, ogUrl, redirectUrl });
    } catch (error) {
        console.error(`Error in v1PostOG function for postId: ${postId}: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

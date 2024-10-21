const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const os = require('os');
const path = require('path');
const functions = require('firebase-functions');

// Initialize Google Cloud Storage with project ID from environment variables
const storage = new Storage({ projectId: functions.config().project_id });

module.exports = async function postOpenGraph(documentId, params, bucketName) {
    const { postId, title, description, image, ogUrl, redirectUrl, refresh } = params;

    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        console.log(`Starting postOpenGraph function for documentId: ${documentId}`);

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

        // Step 2: Create an index.html page with Open Graph metadata and a redirect
        const indexHtmlContent = `
        <html>
          <head>
            <!-- Open Graph Metadata -->
            <meta property="og:title" content="${title}" />
            <meta property="og:description" content="${description}" />
            <meta property="og:image" content="${image}" />
            <meta property="og:url" content="${ogUrl}" />

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
            <h1>Welcome</h1>
            <p>Loading...</p>
          </body>
        </html>
        `;

        // Step 3: Write the HTML content to a local temporary file
        const tempFilePath = path.join(os.tmpdir(), 'index.html');
        fs.writeFileSync(tempFilePath, indexHtmlContent, 'utf8');

        // Define the full bucket name and file path in Cloud Storage (posts/${postId}/og/index.html)
        const fullBucketName = `${bucketName}.appspot.com`;
        const destinationPath = `posts/${postId}/og/index.html`;

        // Step 4: Upload the index.html file to Cloud Storage
        const bucket = storage.bucket(fullBucketName);
        await bucket.upload(tempFilePath, {
            destination: destinationPath,
            metadata: {
                contentType: 'text/html'
            }
        });

        console.log(`index.html uploaded to: ${destinationPath}`);

        // Cleanup: Remove the temporary file
        fs.unlinkSync(tempFilePath);

        // Step 5: Mark the function call as completed
        await functionCallDocRef.update({
            status: 'completed',
            'response.result': 'success',
            'response.data': { postId, ogUrl, redirectUrl },
            'response.completed': serverTimestamp
        });

        console.log(`postOpenGraph function completed successfully for documentId: ${documentId}`);
    } catch (error) {
        console.error(`Error in postOpenGraph function for documentId: ${documentId}: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Step 6: Update the function call status to error or concurrencyError
        await functionCallDocRef.update({
            status: status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

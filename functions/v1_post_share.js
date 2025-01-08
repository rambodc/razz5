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

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract necessary parameters from the request body
    const { uid, title, description, image, redirect_url } = req.body;

    if (!uid || !title || !description || !image || !redirect_url) {
        res.status(400).send("Missing required parameters");
        return { proceed: false };
    }

    // Extract and verify Firebase Auth Token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        console.error(`Error verifying token: ${error.message}`);
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the request UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // General action check before proceeding
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        // Convert Firestore timestamp to JavaScript Date
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        // Check if 24 hours have passed since the last reset
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            // Reset total_actions_today and update reset_global_action_at
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if the user has exceeded the daily limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;

        // Update the actions document with the new values
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, title, description, image, redirect_url };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_post_share = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid, title, description, image, redirect_url } = initResult;
    const shareRef = admin.firestore().collection('share').doc(); // Generate a new document ID

    try {
        console.log(`Creating share document for user: ${uid}`);

        // Add share metadata to Firestore
        const shareData = {
            title,
            description,
            image,
            redirect_url,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        };

        await shareRef.set(shareData);

        const shareId = shareRef.id;

        // Step 1: Generate HTML for the share page
        const htmlContent = `
        <html>
        <head>
            <!-- Open Graph Metadata -->
            <meta property="og:title" content="${title}" />
            <meta property="og:description" content="${description}" />
            <meta property="og:image" content="${image}" />
            <meta property="og:url" content="${redirect_url}" />

            <!-- Twitter Card Metadata -->
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="${title}" />
            <meta name="twitter:description" content="${description}" />
            <meta name="twitter:image" content="${image}" />

            <!-- X (formerly Twitter) Metadata -->
            <meta name="x-card" content="summary_large_image" />
            <meta name="x-title" content="${title}" />
            <meta name="x-description" content="${description}" />
            <meta name="x-image" content="${image}" />

            <!-- Facebook Metadata -->
            <meta property="og:site_name" content="Your Site Name" />
            <meta property="og:type" content="website" />

            <!-- Redirect to your SPA URL -->
            <meta http-equiv="refresh" content="0; url=${redirect_url}" />

            <title>${title}</title>
        </head>
        <body>
            <h1>Redirecting...</h1>
        </body>
        </html>
        `;

        // Step 2: Save the HTML to a temporary file
        const tempFilePath = path.join(os.tmpdir(), 'index.html');
        fs.writeFileSync(tempFilePath, htmlContent, 'utf8');

        // Step 3: Upload the file to Cloud Storage
        const bucketName = functions.config().storage.bucket;
        const bucket = storage.bucket(bucketName);
        const destinationPath = `share/${shareId}/index.html`;

        await bucket.upload(tempFilePath, {
            destination: destinationPath,
            metadata: {
                contentType: 'text/html',
                cacheControl: 'public, max-age=3600' // Optional caching
            }
        });

        console.log(`HTML file uploaded to: ${destinationPath}`);

        // Cleanup: Remove the temporary file
        fs.unlinkSync(tempFilePath);

        // Respond with the share ID and success message
        return res.status(200).send({
            status: "success",
            message: "Share link created successfully",
            share_id: shareId,
            share_url: `https://${functions.config().hosting.site}/share/${shareId}`
        });

    } catch (error) {
        console.error(`Error in v1_post_share: ${error.message}`);
        return res.status(500).send({
            status: "error",
            message: error.message
        });
    }
});

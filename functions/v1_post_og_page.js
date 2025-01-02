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
    const { uid, post_id, title, description, image, og_url, redirect_url, refresh } = req.body;

    if (!uid || !post_id || !title || !description || !image || !og_url || !redirect_url || refresh === undefined) {
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

        return { proceed: true, uid, post_id, title, description, image, og_url, redirect_url, refresh };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_post_og_page = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { post_id, title, description, image, og_url, redirect_url, refresh } = initResult;
    const post_doc_ref = admin.firestore().collection('posts').doc(post_id);

    try {
        console.log(`Starting v1_post_og_page function for post_id: ${post_id}`);

        // Get the server timestamp
        const server_timestamp = admin.firestore.FieldValue.serverTimestamp();

        // Step 1: Transaction to update the post document with the OG object
        await admin.firestore().runTransaction(async (transaction) => {
            const post_doc = await transaction.get(post_doc_ref);

            if (!post_doc.exists) {
                throw new Error(`Post with post_id: ${post_id} does not exist.`);
            }

            const og_data = {
                title,
                description,
                image,
                og_url,
                redirect_url,
                refresh,
                updated_at: server_timestamp
            };

            // Update the post document with the Open Graph data
            transaction.update(post_doc_ref, { og: og_data });

            console.log(`Open Graph data added to post document for post_id: ${post_id}`);
        });

        // Step 2: Create an index.html page with Open Graph and Twitter metadata and a redirect
        const index_html_content = `
        <html>
          <head>
            <!-- Open Graph Metadata -->
            <meta property="og:title" content="${title}" />
            <meta property="og:description" content="${description}" />
            <meta property="og:image" content="${image}" />
            <meta property="og:url" content="${og_url}" />

            <!-- Twitter Card Metadata -->
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="${title}" />
            <meta name="twitter:description" content="${description}" />
            <meta name="twitter:image" content="${image}" />
            <meta name="twitter:url" content="${og_url}" />

            <!-- Redirect to your SPA URL after ${refresh} seconds -->
            <meta http-equiv="refresh" content="${refresh}; url=${redirect_url}" />

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
        const temp_file_path = path.join(os.tmpdir(), 'index.html');
        fs.writeFileSync(temp_file_path, index_html_content, 'utf8');

        // Define the full bucket name and file path in Cloud Storage (posts/${post_id}/og/index.html)
        const full_bucket_name = functions.config().storage.bucket;
        const bucket = storage.bucket(full_bucket_name);
        const destination_path = `posts/${post_id}/og/index.html`;

        // Step 4: Upload the index.html file to Cloud Storage
        await bucket.upload(temp_file_path, {
            destination: destination_path,
            metadata: {
                contentType: 'text/html'
            }
        });

        console.log(`index.html uploaded to: ${destination_path}`);

        // Cleanup: Remove the temporary file
        fs.unlinkSync(temp_file_path);

        // Respond with success message
        return res.status(200).send({ status: "success", message: "Open Graph page created successfully", post_id, og_url, redirect_url });
    } catch (error) {
        console.error(`Error in v1_post_og_page function for post_id: ${post_id}: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

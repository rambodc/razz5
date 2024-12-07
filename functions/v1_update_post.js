// Firebase Cloud Function: v1_update_post.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks for all functions
async function initialize_and_check(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    const { uid } = req.body;

    if (!uid) {
        res.status(400).send("Missing required parameter: uid");
        return { proceed: false };
    }

    try {
        // Verify custom claims for the user
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // General action check before proceeding
        const actions_ref = admin.firestore().collection('actions').doc(uid);
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

        return { proceed: true, uid };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_update_post = functions.https.onRequest(async (req, res) => {
    const init_result = await initialize_and_check(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { uid } = init_result;
    const { object_name, update_user, post_id, ...update_data } = req.body;

    if (!post_id) {
        res.status(400).send("Missing required parameter: post_id");
        return;
    }

    if (!object_name) {
        res.status(400).send("Missing required parameter: object_name");
        return;
    }

    try {
        // Update the specific object in the posts collection
        const post_ref = admin.firestore().collection('posts').doc(post_id);
        await post_ref.set({
            [object_name]: {
                ...update_data
            }
        }, { merge: true });

        if (update_user) {
            // Start a transaction to update user's post data
            const user_ref = admin.firestore().collection('users').doc(uid);
            await admin.firestore().runTransaction(async (transaction) => {
                const user_doc = await transaction.get(user_ref);
                if (!user_doc.exists) {
                    throw new Error('User document does not exist.');
                }

                let user_data = user_doc.data();
                if (!user_data.my_posts || !user_data.my_posts.posts) {
                    throw new Error('User posts data does not exist.');
                }

                // Find the specific post in user's my_posts array and update it
                const post_index = user_data.my_posts.posts.findIndex(post => post.post_id === post_id);
                if (post_index === -1) {
                    throw new Error('Post not found in user data.');
                }

                // Update the post fields at the first level (not inside an object like "general")
                user_data.my_posts.posts[post_index] = {
                    ...user_data.my_posts.posts[post_index],
                    ...update_data
                };

                // Update the user document
                transaction.set(user_ref, user_data, { merge: true });
            });
        }

        // Respond with success message
        res.status(200).send({ status: "success", message: "Post updated successfully" });
    } catch (error) {
        console.error(`Error in v1_update_post function: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});

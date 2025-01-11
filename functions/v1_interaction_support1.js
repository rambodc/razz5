const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Function to perform initial checks and validations
async function initializeAndCheck(req, res) {
    // Set CORS headers for cross-origin requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    // Only allow POST requests
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Validate required UID parameter in the request body
    const { uid } = req.body;
    if (!uid) {
        res.status(400).send("Missing required parameter: uid");
        return { proceed: false };
    }

    // Extract and verify the Firebase Auth token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the provided UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    try {
        // Verify that the user exists in the Firestore database
        const user_ref = admin.firestore().collection('users').doc(uid);
        const user_doc = await user_ref.get();
        if (!user_doc.exists) {
            res.status(404).send("User document does not exist in Firestore");
            return { proceed: false };
        }

        // Check and update action limits for the user
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

        // Reset daily action count if more than 24 hours have passed since the last reset
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Enforce the daily action limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the action count for today
        total_actions_today += 1;
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid };
    } catch (error) {
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_interaction_support1 = functions.https.onRequest(async (req, res) => {
    // Perform initial checks and validations
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid } = initResult;
    const { general, support1 } = req.body;

    try {
        // Check if the interaction already exists in the interactions collection
        const interactionRef = admin.firestore().collection('interactions').doc(general.interaction_id);
        const interactionDoc = await interactionRef.get();
        if (interactionDoc.exists) {
            res.status(400).send({ status: "error", message: "Interaction already exists." });
            return;
        }

        // Extract specific objects from the support1 array
        const supportData = support1.find(item => item.type === 'support');
        const supportersData = support1.find(item => item.type === 'supporters');
        const postValueData = support1.find(item => item.type === 'post_value');

        // Fetch required documents from Firestore
        const [supportDoc, supportersDoc, postDoc] = await Promise.all([
            admin.firestore().collection('users').doc(supportData.uid).get(),
            admin.firestore().collection('users').doc(supportersData.uid).get(),
            admin.firestore().collection('posts').doc(postValueData.post_id).get()
        ]);

        // Ensure all required documents exist
        if (!supportDoc.exists || !supportersDoc.exists || !postDoc.exists) {
            res.status(404).send({ status: "error", message: "Required document does not exist." });
            return;
        }

        // Extract necessary values from the documents
        const totalCollectedRazSupport = supportDoc.data().general.total_collected_raz;
        const totalCollectedRazSupporters = supportersDoc.data().general.total_collected_raz;
        const totalPostRaz = postDoc.data().general.total_post_raz;

        // Update the balance fields in the support1 array
        supportData.balance = totalCollectedRazSupport;
        supportersData.balance = totalCollectedRazSupporters;
        postValueData.balance = totalPostRaz;

        // Run a transaction to update Firestore documents
        await admin.firestore().runTransaction(async (transaction) => {
            // Add the interaction to the interactions collection
            transaction.set(interactionRef, { general, support1 });

            // Update total_collected_raz for the support user
            transaction.update(admin.firestore().collection('users').doc(supportData.uid), {
                "general.total_collected_raz": totalCollectedRazSupport + supportData.amount
            });

            // Update total_collected_raz for the supporters user
            transaction.update(admin.firestore().collection('users').doc(supportersData.uid), {
                "general.total_collected_raz": totalCollectedRazSupporters + supportersData.amount
            });

            // Update total_post_raz in the posts collection
            transaction.update(admin.firestore().collection('posts').doc(postValueData.post_id), {
                "general.total_post_raz": totalPostRaz + postValueData.amount
            });

            // Update the my_posts array in the post_value user's document
            const postValueUserRef = admin.firestore().collection('users').doc(postValueData.uid);
            const postValueUserDoc = await admin.firestore().collection('users').doc(postValueData.uid).get();

            if (postValueUserDoc.exists) {
                const userData = postValueUserDoc.data();

                if (userData.my_posts && Array.isArray(userData.my_posts.posts)) {
                    const updatedPosts = userData.my_posts.posts.map(post => {
                        if (post.post_id === postValueData.post_id) {
                            // Update the total_post_raz for the matching post
                            return { ...post, total_post_raz: totalPostRaz + postValueData.amount };
                        }
                        return post;
                    });

                    // Update the user's my_posts array in Firestore
                    transaction.update(postValueUserRef, {
                        "my_posts.posts": updatedPosts
                    });
                }
            }
        });

        res.status(200).send({ status: "success", message: "Interaction recorded successfully." });
    } catch (error) {
        res.status(500).send({ status: "error", message: error.message });
    }
});

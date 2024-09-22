const admin = require('firebase-admin');

module.exports = async function updatePost(documentId, params) {
    const { postId, ...updateFields } = params; // postId is required, the rest are fields to update

    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const postActionsDocRef = admin.firestore().collection('postActions').doc(postId); // Reference for postActions
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        console.log(`Starting transaction for documentId: ${documentId}`);

        // Get the server timestamp
        const serverTimestamp = admin.firestore.Timestamp.now();

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            console.log(`Reading functionCalls document for documentId: ${documentId}`);

            // Retrieve the functionCalls document to get the top-level uid
            const functionCallDoc = await transaction.get(functionCallDocRef);
            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Retrieve the user's document
            const userUid = functionCallData.uid;
            const userDocRef = admin.firestore().collection('users').doc(userUid);
            console.log(`Reading user document for uid: ${userUid}`);
            const userDoc = await transaction.get(userDocRef);

            let userData = null;
            let postIndex = -1;

            if (userDoc.exists) {
                userData = userDoc.data();
                if (userData.myPosts && Array.isArray(userData.myPosts.posts)) {
                    // Check if the post exists in the user's myPosts array
                    postIndex = userData.myPosts.posts.findIndex(post => post.postId === postId);
                }
            }

            // Mark the function call as processing
            transaction.update(functionCallDocRef, {
                'status': 'processing'
            });

            // Update post document with the provided fields
            const postUpdates = {
                ...updateFields // Apply all provided fields
            };

            console.log(`Updating post document for postId: ${postId}`);
            transaction.update(postDocRef, postUpdates);

            // Also update the postActions document in the same way
            console.log(`Updating postActions document for postId: ${postId}`);
            transaction.update(postActionsDocRef, postUpdates);

            // If the post exists in the user's myPosts array, update it there as well
            if (userData && postIndex !== -1) {
                console.log(`Updating user's post array for postId: ${postId}`);
                Object.keys(updateFields).forEach(key => {
                    userData.myPosts.posts[postIndex][key] = updateFields[key];
                });
                transaction.update(userDocRef, { myPosts: userData.myPosts });
            } else {
                console.log(`PostId ${postId} does not exist in user's myPosts array, only updating post document.`);
            }

            // Update function call status to completed within the transaction
            transaction.update(functionCallDocRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data': postUpdates,
                'response.completed': serverTimestamp
            });

            console.log(`Transaction completed successfully for documentId: ${documentId}`);
        });

    } catch (error) {
        console.error(`Error in updatePost function for documentId: ${documentId}: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Update function call status to error or concurrencyError
        await functionCallDocRef.update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

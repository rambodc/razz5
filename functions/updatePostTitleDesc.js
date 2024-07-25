const admin = require('firebase-admin');

module.exports = async function updatePostTitleDesc(documentId, params) {
    const { postId, uid, title, description, thumbnail200, status } = params;

    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);
    const userDocRef = admin.firestore().collection('users').doc(uid);

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

            // Retrieve the post document
            console.log(`Reading post document for postId: ${postId}`);
            const postDoc = await transaction.get(postDocRef);

            if (!postDoc.exists) {
                throw new Error(`Post document for ${postId} does not exist.`);
            }

            // Retrieve the user's document
            console.log(`Reading user document for uid: ${uid}`);
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

            // Now perform all updates within the transaction
            const postUpdates = {
                title: title,
                description: description,
                status: status,
                updatedAt: serverTimestamp
            };

            // Update the post document with new title, description, and status
            transaction.update(postDocRef, postUpdates);

            if (userData && postIndex !== -1) {
                // Update the title, description, status, and thumbnail200 in the user's myPosts array
                userData.myPosts.posts[postIndex].title = title;
                userData.myPosts.posts[postIndex].description = description;
                userData.myPosts.posts[postIndex].status = status;
                userData.myPosts.posts[postIndex].thumbnail200 = thumbnail200;

                // Update the user's document with the modified myPosts array
                transaction.update(userDocRef, { myPosts: userData.myPosts });
            }

            // Update function call status to completed within the transaction
            transaction.update(functionCallDocRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data': {
                    postId: postId,
                    title: title,
                    description: description,
                    status: status,
                    thumbnail200: thumbnail200
                },
                'response.completed': serverTimestamp
            });

            console.log(`Transaction completed successfully for documentId: ${documentId}`);
        });

    } catch (error) {
        console.error(`Error in updatePostTitleDesc function for documentId: ${documentId}: ${error.message}`);

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

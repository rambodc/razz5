const admin = require('firebase-admin');

module.exports = async function createPost(documentId, params) {
    const { 
        postId, 
        uid, 
        status, 
        postType, 
        isArchived, 
        thumbnailUrl,  // Updated from originalUrl to thumbnailUrl
        fileType, 
        fileFormat, 
        title, 
        description, 
        version 
    } = params;

    const MAX_POSTS = 100;  // Maximum number of posts to keep in the array

    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);
    const postActionsDocRef = admin.firestore().collection('postActions').doc(postId); // New collection for post actions

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

            if (!userDoc.exists) {
                throw new Error(`User document for ${userUid} does not exist.`);
            }

            let userData = userDoc.data();
            if (!userData.myPosts) {
                console.log(`Initializing myPosts for user: ${userUid}`);
                userData.myPosts = {
                    posts: [],
                    myPostCount: 0
                };
            }

            // Check if the post already exists in the posts array
            const postExists = userData.myPosts.posts.some(post => post.postId === postId);
            if (postExists) {
                console.log(`Post with postId: ${postId} already exists for user: ${userUid}`);
                return;
            }

            // Mark the function call as processing
            transaction.update(functionCallDocRef, {
                'status': 'processing'
            });

            // Add new post to the posts array with createdAt timestamp
            const newPost = {
                postId: postId,
                status: status,
                postType: postType,
                isArchived: isArchived,
                thumbnailUrl: thumbnailUrl,  // Updated from originalUrl to thumbnailUrl
                fileType: fileType,
                fileFormat: fileFormat,
                title: title,
                description: description,
                createdAt: serverTimestamp,
                version: version
            };

            userData.myPosts.posts.unshift(newPost); // Add the new post at the beginning of the array

            // Check if the array exceeds the maximum limit
            if (userData.myPosts.posts.length > MAX_POSTS) {
                userData.myPosts.posts.pop(); // Remove the oldest post
            }

            // Update the myPostCount
            userData.myPosts.myPostCount = userData.myPosts.posts.length;

            // Create new post record
            const postRecord = {
                postId: postId,
                uid: uid,
                status: status,
                postType: postType,
                isArchived: isArchived,
                thumbnailUrl: thumbnailUrl,  // Updated from originalUrl to thumbnailUrl
                fileType: fileType,
                fileFormat: fileFormat,
                title: title,
                description: description,
                createdAt: serverTimestamp,
                version: version
            };

            console.log(`Writing post record and updating user document for uid: ${userUid}`);

            // Perform all writes after all reads
            transaction.set(postDocRef, postRecord);
            transaction.update(userDocRef, { myPosts: userData.myPosts });

            // Create a new document in the postActions collection
            const postActionRecord = {
                postId: postId,
                uid: uid,
                version: "1.1",
                status: "uploaded",
                postType: "general",
                isArchived: false,
                thumbnailUrl: thumbnailUrl,  // Updated from originalUrl to thumbnailUrl
                fileType: fileType,
                fileFormat: fileFormat,
                createdAt: serverTimestamp
            };
            transaction.set(postActionsDocRef, postActionRecord); // Add the postAction document

            // Update function call status to completed within the transaction
            transaction.update(functionCallDocRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data': postRecord,
                'response.completed': serverTimestamp
            });

            console.log(`Transaction completed successfully for documentId: ${documentId}`);
        });

    } catch (error) {
        console.error(`Error in createPost function for documentId: ${documentId}: ${error.message}`);

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

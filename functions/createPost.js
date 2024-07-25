/*
Steps of the function:

1. Import required module: 'firebase-admin'.
2. Export an asynchronous function 'createPost' with parameters: documentId and params.
3. Extract parameters from the 'params' object: postId, uid, status, postType, isArchived, originalUrl, fileType, fileFormat, title, description, and version.
4. Define Firestore references for 'functionCalls', 'posts', and 'users' collections.
5. Get the server timestamp.
6. Run the entire operation in a Firestore transaction:
    a. Retrieve the functionCalls document using 'documentId'.
    b. Check if the function call status is 'processing'. If so, throw an error.
    c. Retrieve the user's document using the uid from the functionCalls document.
    d. If the user's document does not exist, throw an error.
    e. Initialize the 'myPosts' field in the user's document if it does not exist.
    f. Check if the post already exists in the 'myPosts' array. If so, return.
    g. Mark the function call as processing.
    h. Add a new post to the 'myPosts' array with the createdAt timestamp.
    i. Update the 'myPostCount'.
    j. Create a new post record.
    k. Write the post record and update the user's document.
    l. Update the function call status to 'completed' with the response data.
7. Catch and handle any errors:
    a. Log the error message.
    b. Update the function call document with the appropriate error status and message.
*/

const admin = require('firebase-admin');

module.exports = async function createPost(documentId, params) {
    const { 
        postId, 
        uid, 
        status, 
        postType, 
        isArchived, 
        originalUrl, 
        fileType, 
        fileFormat, 
        title, 
        description, 
        version 
    } = params;

    const MAX_POSTS = 100;  // Maximum number of posts to keep in the array

    const postDocRef = admin.firestore().collection('posts').doc(postId);
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
                originalUrl: originalUrl,
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
                originalUrl: originalUrl,
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

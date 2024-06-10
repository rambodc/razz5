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
    thumbnailUrl,
    title, // Added title to params
    description, // Added description to params
    version // Added version to params
  } = params;

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
      const userUid = functionCallData.uid;
      const userDocRef = admin.firestore().collection('users').doc(userUid);

      // Retrieve the user's document
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

      // Add new post to the posts array with createdAt timestamp
      userData.myPosts.posts.push({
        postId: postId,
        status: status,
        postType: postType,
        isArchived: isArchived,
        originalUrl: originalUrl,
        fileType: fileType,
        fileFormat: fileFormat,
        thumbnailUrl: thumbnailUrl,
        title: title, // Added title to the post object
        description: description, // Added description to the post object
        createdAt: serverTimestamp,
        version: version // Added version to the post object
      });

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
        thumbnailUrl: thumbnailUrl,
        title: title, // Added title to the post record
        description: description, // Added description to the post record
        createdAt: serverTimestamp,
        version: version // Added version to the post record
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

    // Update function call status to error
    await functionCallDocRef.update({
      'status': 'error',
      'response.errorMessage': error.message,
      'response.error': admin.firestore.FieldValue.serverTimestamp()
    });
  }
};

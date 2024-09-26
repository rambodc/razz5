const admin = require('firebase-admin');

module.exports = async function feedCollect(documentId, params) {
    const {
        transactionObject,
    } = params;

    const {
        txnId,
        postId,
        uid: senderUid,  // This is the "Main Level" UID you want to store in the txn array in postActions
        sender,
        receivers
    } = transactionObject;

    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);
    const txnDocRef = admin.firestore().collection('transactions').doc(txnId);
    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const postActionsDocRef = admin.firestore().collection('postActions').doc(postId);
    const userRefs = receivers.map(receiver => admin.firestore().collection('users').doc(receiver.uid));
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

    try {
        console.log(`Starting feedCollect function for documentId: ${documentId}`);

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Step 1: Perform reads first to check if the txnId already exists
            const [functionCallDoc, existingTxnDoc, postDoc, postActionsDoc, ...userDocs] = await Promise.all([
                transaction.get(functionCallDocRef),
                transaction.get(txnDocRef), // Check if the txnId already exists
                transaction.get(postDocRef),
                transaction.get(postActionsDocRef),
                ...userRefs.map(ref => transaction.get(ref))
            ]);

            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            if (!postDoc.exists) {
                throw new Error(`Post document for postId ${postId} does not exist.`);
            }

            const functionCallData = functionCallDoc.data();
            const postDocData = postDoc.data();
            const postActionsDocData = postActionsDoc.exists ? postActionsDoc.data() : {};

            // Step 2: Check if the function is already being processed
            if (functionCallData.status === 'processing') {
                console.log(`Function already processing for documentId: ${documentId}`);
                throw new Error('This function call is already being processed.');
            }

            // Step 3: Check if the txnId already exists
            if (existingTxnDoc.exists) {
                console.log(`Transaction with txnId: ${txnId} already exists, skipping new transaction creation.`);
                return;
            }

            // Step 4: Mark the function call as "processing"
            transaction.update(functionCallDocRef, { status: 'processing' });

            // Step 5: Create a new transaction document in the 'transactions' collection
            transaction.set(txnDocRef, {
                ...transactionObject,
                createdAt: serverTimestamp
            }, { merge: true });

            // Step 6: Update the post document with totalPostRaz
            const totalPostRaz = postDocData.totalPostRaz || 0;
            const updatedTotalPostRaz = totalPostRaz + sender.amount;
            transaction.update(postDocRef, {
                totalPostRaz: updatedTotalPostRaz
            });

            // Step 7: Update the postActions document to store only the uid from the top-level of the param
            const seenArray = postActionsDocData.seen || [];
            const txnArray = postActionsDocData.txn || [];

            // Store only the senderUid (top-level uid) in the txn array
            if (!txnArray.includes(senderUid)) {
                txnArray.push(senderUid);
            }

            transaction.set(postActionsDocRef, {
                seen: seenArray,
                txn: txnArray  // Storing only senderUid in txn array
            }, { merge: true });

            // Step 8: Update users document for both receivers
            for (const receiver of receivers) {
                const userDoc = userDocs.find(doc => doc.id === receiver.uid);

                if (userDoc.exists) {
                    const userDocData = userDoc.data();
                    const totalRaz = userDocData.totalRaz || 0;
                    const updatedTotalRaz = totalRaz + receiver.amount;

                    // Update the totalRaz for the user
                    transaction.update(userDoc.ref, {
                        totalRaz: updatedTotalRaz
                    });

                    // Additional logic to update totalRaz for myFollowing and myFollowers
                    if (receiver.type === 'feedCollector') {
                        // Check the postCreator's following section
                        const postCreator = receivers.find(r => r.type === 'postCreator');
                        if (postCreator) {
                            const followingArray = userDocData.myFollowing.following || [];
                            const followingUser = followingArray.find(f => f.uid === postCreator.uid);

                            if (followingUser) {
                                // Update totalRaz for postCreator in feedCollector's following
                                const updatedFollowingRaz = followingUser.totalRaz + receiver.amount;
                                followingUser.totalRaz = updatedFollowingRaz;

                                // Update the existing following user record in Firestore
                                transaction.update(userDoc.ref, {
                                    'myFollowing.following': followingArray
                                });
                            } else {
                                // Throw an error if postCreator is not found in feedCollector's following
                                throw new Error(`Post creator UID not found in feedCollector's following array.`);
                            }
                        }
                    }

                    if (receiver.type === 'postCreator') {
                        // Check the feedCollector's followers section
                        const feedCollector = receivers.find(r => r.type === 'feedCollector');
                        if (feedCollector) {
                            const followersArray = userDocData.myFollowers.followers || [];
                            const followerUser = followersArray.find(f => f.uid === feedCollector.uid);

                            if (followerUser) {
                                // Update totalRaz for feedCollector in postCreator's followers
                                const updatedFollowerRaz = followerUser.totalRaz + receiver.amount;
                                followerUser.totalRaz = updatedFollowerRaz;

                                // Update the existing follower user record in Firestore
                                transaction.update(userDoc.ref, {
                                    'myFollowers.followers': followersArray
                                });
                            } else {
                                // Throw an error if feedCollector is not found in postCreator's followers array
                                throw new Error(`Feed collector UID not found in postCreator's followers array.`);
                            }
                        }
                    }
                }
            }

            // Step 9: Mark the function call as "completed"
            transaction.update(functionCallDocRef, {
                status: 'completed',
                'response.result': 'success',
                'response.data.txnId': txnId,
                'response.data.postId': postId,
                'response.completed': serverTimestamp
            });
        });

        console.log(`FeedCollect function successfully completed for documentId: ${documentId}`);
    } catch (error) {
        console.error(`Error in feedCollect function for documentId: ${documentId}: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Update function call status to error or concurrencyError
        await functionCallDocRef.update({
            status: status,
            'response.errorMessage': errorMessage,
            'response.error': serverTimestamp
        });
    }
};

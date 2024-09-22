const admin = require('firebase-admin');

module.exports = async function feedCollect(documentId, params) {
    const {
        transactionObject,
    } = params;

    const {
        txnId,
        postId,
        uid: senderUid,
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
            // Step 1: Perform all reads first
            const [functionCallDoc, postDoc, postActionsDoc, ...userDocs] = await Promise.all([
                transaction.get(functionCallDocRef),
                transaction.get(postDocRef),
                transaction.get(postActionsDocRef),
                ...userRefs.map(ref => transaction.get(ref))
            ]);

            // Ensure all documents exist
            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            if (!postDoc.exists) {
                throw new Error(`Post document for postId ${postId} does not exist.`);
            }

            const functionCallData = functionCallDoc.data();
            const postDocData = postDoc.data();

            // Step 2: Check if the function is already being processed
            if (functionCallData.status === 'processing') {
                console.log(`Function already processing for documentId: ${documentId}`);
                throw new Error('This function call is already being processed.');
            }

            // All reads are done here, now we can perform the writes

            // Step 3: Mark the function call as "processing"
            transaction.update(functionCallDocRef, { status: 'processing' });

            // Step 4: Update the post document's totalPostRaz securely
            const totalPostRaz = postDocData.totalPostRaz || 0;
            const updatedTotalPostRaz = totalPostRaz + sender.amount;
            transaction.update(postDocRef, { totalPostRaz: updatedTotalPostRaz });

            // Step 5: Update the postActions document
            const feedCollectorReceiver = receivers.find(receiver => receiver.type === 'feedCollector');
            const feedCollectorUid = feedCollectorReceiver ? feedCollectorReceiver.uid : null;

            if (feedCollectorUid) {
                const postActionsDocData = postActionsDoc.exists ? postActionsDoc.data() : {};
                const seenArray = postActionsDocData.seen || [];
                const txnArray = postActionsDocData.txn || [];

                if (!seenArray.includes(feedCollectorUid)) {
                    seenArray.push(feedCollectorUid);
                }

                if (!txnArray.includes(feedCollectorUid)) {
                    txnArray.push(feedCollectorUid);
                }

                transaction.set(postActionsDocRef, {
                    seen: seenArray,
                    txn: txnArray
                }, { merge: true });
            }

            // Step 6: Update users document for both receivers using atomic increment
            for (const receiver of receivers) {
                const userDoc = userDocs.find(doc => doc.id === receiver.uid);

                if (userDoc.exists) {
                    const receiverAmount = receiver.amount || 0;

                    console.log(`Updating totalRaz for user ${receiver.uid} by adding amount: ${receiverAmount}`);

                    // Use Firestore's FieldValue.increment to atomically update totalRaz
                    transaction.update(userDoc.ref, {
                        totalRaz: admin.firestore.FieldValue.increment(receiverAmount)
                    });
                } else {
                    console.warn(`User document for ${receiver.uid} does not exist.`);
                }
            }

            // Mark the function call as "completed"
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

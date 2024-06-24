const admin = require('firebase-admin');

module.exports = async function createPostWorkflow(documentId, params) {
    const { step1, step2, step3 } = params;
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        console.log(`Starting workflow for documentId: ${documentId}`);

        await executeStep(step1, 'step1', functionCallDocRef);
        await executeStep(step2, 'step2', functionCallDocRef);
        await executeStep(step3, 'step3', functionCallDocRef);

        console.log(`Workflow completed successfully for documentId: ${documentId}`);
        
        // Update createPostWorkflow document with completion status
        await functionCallDocRef.update({
            'status': 'completed',
            'response.result': 'success',
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in createPostWorkflow function: ${error.message}`);

        // Update createPostWorkflow document with error status
        await functionCallDocRef.update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

async function executeStep(step, stepName, functionCallDocRef) {
    return new Promise(async (resolve, reject) => {
        console.log(`Executing ${stepName}`);
        try {
            const stepWithTimestamp = {
                ...step,
                created: admin.firestore.FieldValue.serverTimestamp()
            };

            const stepDocRef = await admin.firestore().collection('functionCalls').add(stepWithTimestamp);
            console.log(`${stepName} document created with ID: ${stepDocRef.id}`);

            let unsubscribe = null;
            const checkStatus = async () => {
                const doc = await stepDocRef.get();
                if (doc.exists) {
                    const data = doc.data();
                    if (data.status === 'completed') {
                        console.log(`${stepName} completed successfully`);
                        if (unsubscribe) unsubscribe();
                        resolve();
                    } else if (data.status === 'error') {
                        console.error(`${stepName} failed with error: ${data.response.errorMessage}`);
                        if (unsubscribe) unsubscribe();
                        await functionCallDocRef.update({
                            'status': 'error',
                            'response.result': 'error',
                            'response.data': {
                                [stepName]: data.response
                            },
                            'response.error': admin.firestore.FieldValue.serverTimestamp()
                        });
                        reject(new Error(`Error in ${stepName}: ${data.response.errorMessage}`));
                    }
                }
            };

            unsubscribe = admin.firestore().collection('functionCalls').doc(stepDocRef.id)
                .onSnapshot(async () => {
                    await checkStatus();
                }, (error) => {
                    console.error(`Failed to listen to document updates for ${stepName}: ${error.message}`);
                    if (unsubscribe) unsubscribe();
                    reject(new Error(`Failed to listen to document updates for ${stepName}: ${error.message}`));
                });

            // Initial status check to prevent multiple executions
            await checkStatus();

        } catch (error) {
            console.error(`Failed to execute ${stepName}: ${error.message}`);
            reject(new Error(`Failed to execute ${stepName}: ${error.message}`));
        }
    });
}

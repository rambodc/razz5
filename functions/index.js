const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.functionHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        const functionName = data.functionName;
        const parameters = data.parameters;
        const documentId = context.params.documentId;

        try {
            const func = require(`./${functionName}`);

            if (func && typeof func === 'function') {
                await func(documentId, parameters);
            } else {
                throw new Error(`The function ${functionName} is not available or is not a valid function.`);
            }
        } catch (error) {
            console.error(`Error executing ${functionName}: ${error}`);

            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': 'error',
                'response.errorMessage': error.message,
                'response.error': admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });

    
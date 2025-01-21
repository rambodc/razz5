// Firebase Cloud Function: extAddUidPost.js
const functions = require("firebase-functions/v1");

exports.extAddUidPost = functions.https.onRequest((req, res) => {
    try {
        const payload = req.body;

        // Check if 'data' field is present and is an array
        if (payload.data && Array.isArray(payload.data) && payload.data.length > 0) {
            const firstDataItem = payload.data[0];

            // Parse the 'data' field within 'json' if it exists
            if (firstDataItem.json && firstDataItem.json.data) {
                const dataJson = JSON.parse(firstDataItem.json.data);

                // Add 'uid' as a top-level field if it exists
                if (dataJson && dataJson.uid) {
                    firstDataItem.json.user_uid = dataJson.uid;  // Add 'uid' as a new top-level field called 'user_uid'
                }
            }
        }

        // Send the transformed payload back with the same structure
        res.status(200).send(payload);
    } catch (error) {
        console.error("Transformation error: ", error);
        res.status(500).send("Transformation failed");
    }
});

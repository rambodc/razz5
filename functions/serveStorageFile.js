const functions = require('firebase-functions');
const { Storage } = require('@google-cloud/storage');
const storage = new Storage();  // Initialize the Storage

// Cloud Function to serve Firebase Storage files through custom URL
exports.serveStorageFile = functions.https.onRequest(async (req, res) => {
  const filePath = req.path; // Get the path from the request (e.g., "/posts/unique-post-id/og/index.html")
  const bucket = storage.bucket('razz5-14781.appspot.com'); // Your Firebase Storage bucket

  try {
    const file = bucket.file(filePath); // Access the file in storage
    const [exists] = await file.exists();

    if (!exists) {
      res.status(404).send('File not found');
      return;
    }

    // Fetch a signed URL (or use a public URL if no token is needed)
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // This makes the URL effectively permanent
    });

    // Redirect the user to the actual Firebase Storage URL
    res.redirect(url);
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).send('Internal Server Error');
  }
});

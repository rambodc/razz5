const functions = require('firebase-functions');

// Standalone function exports


exports.extAddUidPost = require('./extAddUidPost').extAddUidPost;
exports.extAddUidUser = require('./extAddUidUser').extAddUidUser;
exports.v1_user_setup = require('./v1_user_setup').v1_user_setup;
exports.v1_last_reset_time = require('./v1_last_reset_time').v1_last_reset_time;
exports.v1_update_email = require('./v1_update_email').v1_update_email;
exports.v1_update_utc_offset = require('./v1_update_utc_offset').v1_update_utc_offset;
exports.v1_update_email_verified = require('./v1_update_email_verified').v1_update_email_verified;
exports.v1_create_new_chat = require('./v1_create_new_chat').v1_create_new_chat;
exports.v1_update_chat = require('./v1_update_chat').v1_update_chat;
exports.v1_pinata_upload = require('./v1_pinata_upload').v1_pinata_upload;
exports.v1_create_post = require('./v1_create_post').v1_create_post;
exports.v1_resize_file = require('./v1_resize_file').v1_resize_file;
exports.v1_update_post = require('./v1_update_post').v1_update_post;
exports.v1_video_thumbnail = require('./v1_video_thumbnail').v1_video_thumbnail;
exports.v1_media_ai = require('./v1_media_ai').v1_media_ai;
exports.v1_delete_post = require('./v1_delete_post').v1_delete_post;
exports.v1_update_user = require('./v1_update_user').v1_update_user;
exports.v1_create_revision_1 = require('./v1_create_revision_1').v1_create_revision_1;
exports.v1_txn_sign_vm = require('./v1_txn_sign_vm').v1_txn_sign_vm;
exports.v1_post_share = require('./v1_post_share').v1_post_share;
exports.v1_serve_share = require('./v1_serve_share').v1_serve_share;
exports.v1_interaction_support1 = require('./v1_interaction_support1').v1_interaction_support1;
exports.v1_interaction_new_post1 = require('./v1_interaction_new_post1').v1_interaction_new_post1;

exports.v1_feed_test1 = require('./v1_feed_test1').v1_feed_test1;
exports.v1_easy_qr = require('./v1_easy_qr').v1_easy_qr;

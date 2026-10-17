const mongoose = require("mongoose");

// One document per browser/device subscription (the endpoint is unique to a device).
const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 2048 },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    expiration_time: { type: Date, default: null },
    user_agent: { type: String, default: "", maxlength: 300 },
    failures: { type: Number, default: 0 },                     // consecutive temporary send failures
  },
  { timestamps: true },
);

module.exports = mongoose.model("push_subscription", schema);

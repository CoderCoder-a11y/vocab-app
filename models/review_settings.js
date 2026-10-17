const mongoose = require("mongoose");

// One document per user: review limits + daily reminder preferences.
const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true, unique: true },
    daily_new_limit: { type: Number, min: 0, max: 500 },        // unset => server default (20)
    reminder_enabled: { type: Boolean, default: false },
    reminder_time: { type: String, default: "20:00" },          // HH:MM in the user's time zone
    timezone: { type: String, default: "UTC" },                 // IANA id, e.g. Africa/Cairo
    // Local date (YYYY-MM-DD) of the last reminder: claimed atomically so a day's reminder is sent once,
    // even with several PM2 processes.
    last_reminder_date: { type: String, default: "" },
  },
  { timestamps: true },
);

schema.index({ reminder_enabled: 1 });

module.exports = mongoose.model("review_settings", schema);

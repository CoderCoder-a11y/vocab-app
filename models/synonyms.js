const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    word: { type: String, required: true },
    // Lower-cased word, so one document per user + word can be upserted.
    word_key: { type: String, index: true },
    synonyms: { type: [String], default: [] },
    antonyms: { type: [String], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("synonyms", schema);

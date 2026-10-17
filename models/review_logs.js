const mongoose = require("mongoose");

// One document per review. Never updated or removed when the card state changes,
// so success rate and progress over time can always be computed from it.
const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true },
    vocab_id: { type: String, required: true },
    word: { type: String, default: "" },                       // snapshot, for the history list

    rating: { type: Number, enum: [1, 2, 3, 4], required: true }, // 1 Again, 2 Hard, 3 Good, 4 Easy
    rating_name: { type: String, enum: ["Again", "Hard", "Good", "Easy"], required: true },
    review: { type: Date, required: true },                     // when the user answered

    state_before: { type: Number, required: true },
    state_after: { type: Number, required: true },
    due_before: { type: Date },
    due_after: { type: Date, required: true },
    scheduled_days_before: { type: Number, default: 0 },        // previous interval
    scheduled_days_after: { type: Number, default: 0 },         // next interval
    elapsed_days: { type: Number, default: 0 },
    last_elapsed_days: { type: Number, default: 0 },
    stability_before: { type: Number, default: 0 },
    stability_after: { type: Number, default: 0 },
    difficulty_before: { type: Number, default: 0 },
    difficulty_after: { type: Number, default: 0 },
    learning_steps_before: { type: Number, default: 0 },
    learning_steps_after: { type: Number, default: 0 },
    reps_before: { type: Number, default: 0 },
    reps_after: { type: Number, default: 0 },
    lapses_after: { type: Number, default: 0 },

    // Client-generated id of one "press": a repeated request with the same id is a replay, not a new review.
    request_id: { type: String },
    fsrs_version: { type: String },
    request_retention: { type: Number },
  },
  { timestamps: true },
);

schema.index({ user_id: 1, review: -1 });
schema.index({ user_id: 1, vocab_id: 1, review: -1 });
schema.index({ user_id: 1, state_before: 1, review: -1 });
schema.index(
  { user_id: 1, request_id: 1 },
  { unique: true, partialFilterExpression: { request_id: { $type: "string" } } },
);

module.exports = mongoose.model("review_log", schema);

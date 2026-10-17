const mongoose = require("mongoose");
const { emptyCardFields } = require("../utils/fsrs_service");

const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    word: { type: String, required: true, trim: true },
    image: { type: String },                        // first picture (kept for old clients)
    images: { type: [String], default: [] },        // pictures found by Tavily (3+)
    meaning: { type: String, required: true },      // English definition
    meaning_ar: { type: String, default: "" },      // Arabic meaning
    example: { type: String, required: true },      // main example sentence
    examples: { type: [String], default: [] },      // all generated examples
    category: { type: String, required: true },     // topic (Business, Travel, ...)
    part_of_speech: { type: String, default: "" },
    source: { type: String, enum: ["ai", "manual"], default: "ai" },

    // ---- FSRS memory state (see utils/fsrs_service.js; mirrors the ts-fsrs Card) ----
    // Words created before this feature have none of these fields: they are treated as
    // New cards when reviewed (fsrs_service.toCard) and need no migration.
    due: { type: Date },                       // next review time
    stability: { type: Number },               // memory stability (days)
    difficulty: { type: Number },              // card difficulty
    elapsed_days: { type: Number },            // days since the previous review
    scheduled_days: { type: Number },          // interval chosen at the last review
    learning_steps: { type: Number },          // current (re)learning step
    reps: { type: Number },                    // number of reviews
    lapses: { type: Number },                  // times forgotten while in Review state
    state: { type: Number, enum: [0, 1, 2, 3] }, // 0 New, 1 Learning, 2 Review, 3 Relearning
    last_review: { type: Date, default: null },
  },
  { timestamps: true },
);

// New words start as a brand new card created by the FSRS library itself.
schema.pre("validate", function initFsrsCard() {
  if (this.isNew && (this.state === undefined || this.state === null)) {
    Object.assign(this, emptyCardFields(new Date()));
  }
});

// Fast "what is due now" / "next new words" queries.
schema.index({ user_id: 1, state: 1, due: 1 });
schema.index({ user_id: 1, createdAt: 1 });

module.exports = mongoose.model("vocabulary", schema);
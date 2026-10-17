const mongoose = require("mongoose");

const isValidId = (id) =>
    (typeof id === "string" || id instanceof mongoose.Types.ObjectId) &&
    /^[a-f\d]{24}$/i.test(String(id));

const isNonEmptyValue = (value) => {
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== "";
};

// `code` is a stable machine-readable reason the frontend can translate.
const sendError = (res, status, message, code) =>
    res.status(status).json({ success: false, message, code, data: [] });

const handleError = (res, error) => {
    console.error("[API]", error);

    if (
        error instanceof mongoose.Error.ValidationError ||
        error instanceof mongoose.Error.CastError
    ) {
        return sendError(res, 400, "Invalid request data", "INVALID_DATA");
    }

    return sendError(res, 500, "Internal server error", "SERVER_ERROR");
};

module.exports = { isValidId, isNonEmptyValue, sendError, handleError };

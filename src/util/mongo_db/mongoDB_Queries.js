const mongoose = require("mongoose");
const { escapeRegex } = require("../helper");

// List with filter + search + sort + pagination
// Query string:
//   page, limit, sort, order=asc|desc, includeDeleted=true
//   q=<text> & q_key=["name_en","name_kh"]      → keyword search
//   q_id=["<id>"] & q_key_id=["category_id"]   → filter by ids
async function getFilteredMongoDB(query, Model, populate = [], additionalFilter = []) {
  // Pagination
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 200);
  const skip = (page - 1) * limit;

  // Sorting
  const sortField = typeof query.sort === "string" && query.sort ? query.sort : "created_date";
  const sortOrder = query.order === "asc" ? 1 : -1;

  // Soft delete toggle
  const includeDeleted = query.includeDeleted === "true";
  const deleteFilter = includeDeleted ? {} : { deleted: false };

  // Specific ID Filter (q_id + q_key_id)
  const qId = query.q_id;
  const qKeyId = query.q_key_id;
  let specificOr = [];

  if (qId && qKeyId) {
    let ids;
    let fields;

    try {
      ids = Array.isArray(qId) ? qId : JSON.parse(qId);
      if (!Array.isArray(ids)) ids = [ids];
    } catch {
      ids = [qId];
    }

    try {
      fields = Array.isArray(qKeyId) ? qKeyId : JSON.parse(qKeyId || "[]");
      if (!Array.isArray(fields)) fields = [fields];
    } catch {
      fields = qKeyId ? String(qKeyId).split(",") : [];
    }

    const validObjectIds = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (fields.length && validObjectIds.length) {
      specificOr = fields
        .filter((field) => typeof field === "string" && !field.startsWith("$"))
        .map((field) => ({ [field]: { $in: validObjectIds } }));
    }
  }

  // General keyword search (q + q_key)
  const keyword = typeof query.q === "string" ? query.q.trim() : "";
  const qKeys = query.q_key;
  let generalOr = [];

  if (keyword && qKeys) {
    let fields;

    try {
      fields = Array.isArray(qKeys) ? qKeys : JSON.parse(qKeys || "[]");
      if (!Array.isArray(fields)) fields = [fields];
    } catch {
      fields = qKeys ? String(qKeys).split(",") : [];
    }

    generalOr = fields
      .filter((field) => typeof field === "string" && !field.startsWith("$"))
      .map((field) => {
        if (field.endsWith("_id") && mongoose.Types.ObjectId.isValid(keyword)) {
          return { [field]: new mongoose.Types.ObjectId(keyword) };
        }
        return { [field]: { $regex: escapeRegex(keyword), $options: "i" } };
      });
  }

  // Compose final MongoDB filter
  const mongoFilter = { ...deleteFilter };

  if (specificOr.length && generalOr.length) {
    mongoFilter.$and = [{ $or: specificOr }, { $or: generalOr }];
  } else if (specificOr.length) {
    mongoFilter.$or = specificOr;
  } else if (generalOr.length) {
    mongoFilter.$or = generalOr;
  }

  // ✅ Add additional filters like { category_id: id }
  if (additionalFilter.length > 0) {
    if (mongoFilter.$and) {
      mongoFilter.$and.push(...additionalFilter);
    } else {
      mongoFilter.$and = [...additionalFilter];
    }
  }

  // Query database with filter, pagination, sorting
  const [data, total] = await Promise.all([
    Model.find(mongoFilter)
      .sort({ [sortField]: sortOrder, _id: sortOrder })
      .populate(populate)
      .skip(skip)
      .limit(limit),
    Model.countDocuments(mongoFilter),
  ]);

  return {
    data,
    pagination: {
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      pageSize: limit,
    },
  };
}

module.exports = getFilteredMongoDB;

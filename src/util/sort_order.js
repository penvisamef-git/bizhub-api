const mongoose = require("mongoose");

// Save a new order after drag & drop in the admin
// body: { items: [{ _id: "<id>", sort_order: 1 }, ...] }
async function saveSortOrder(Model, items, userId) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "សូមបញ្ចូល items [{ _id, sort_order }]" };
  }

  const ops = [];
  for (const row of items) {
    if (!row || !mongoose.Types.ObjectId.isValid(row._id) || !Number.isFinite(Number(row.sort_order))) {
      return { ok: false, message: "items មិនត្រឹមត្រូវ!" };
    }
    ops.push({
      updateOne: {
        filter: { _id: row._id, deleted: false },
        update: { $set: { sort_order: Number(row.sort_order), updated_by: userId } },
      },
    });
  }

  const result = await Model.bulkWrite(ops);
  return { ok: true, modified: result.modifiedCount };
}

module.exports = { saveSortOrder };

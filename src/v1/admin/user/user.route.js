const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const UserModel = require("./user.model");
const SessionModel = require("../session/session.model");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../util/log");
const { checkValidtion, sanitizeUpdate, removeEmpty } = require("../../../util/helper");
const { USER_ROLES } = require("../../../util/user_roles");
const { can_manage_users } = require("../../../util/permission");
const baseRoute = "users";

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "user";
  // Error Content
  const document = "អ្នកប្រើប្រាស់";

  function updatedText(name) {
    return `${document} ${name} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  }
  function deletedText(name) {
    return `${document} ${name} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  }
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `អ្នកប្រើប្រាស់ (សារអេឡិចត្រូនិច) មាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const roleInvalid = `តួនាទីមិនត្រឹមត្រូវ! (${USER_ROLES.join(" | ")})`;
  const shortPassword = "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ!";
  const cannotSelf = "មិនអាចលុប ឬផ្អាកគណនីខ្លួនឯងបានទេ!";

  const fullName = (u) => `${u.firstname} ${u.lastname}`;

  // Super admin accounts are hidden and cannot be changed from the API
  const notSuperAdmin = { is_super_admin: false };

  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_users];

  // ===================================== CREATE ================================================
  prop.app.post(`${urlAPI}`, ...guard, async (req, res) => {
    try {
      // ✅ Validate required fields
      const requiredFields = [
        { key: "firstname", label: "គោត្តនាម" },
        { key: "lastname", label: "នាម" },
        { key: "email", label: "សារអេឡិចត្រូនិច" },
        { key: "password", label: "ពាក្យសម្ងាត់" },
        { key: "role", label: "តួនាទី" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const { user_id: userId } = req.session;
      const { firstname, lastname, contact, job_title, password, role, note, status } = req.body;
      const email = String(req.body.email).trim().toLowerCase();

      if (!USER_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: roleInvalid });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ success: false, message: shortPassword });
      }

      // ✅ Check duplicate email
      const exists = await UserModel.exists({ email, deleted: false });
      if (exists) {
        return res.status(409).json({ success: false, message: existsText });
      }

      // ✅ Create
      const saveData = await UserModel.create({
        firstname,
        lastname,
        contact,
        email,
        job_title,
        password: await bcrypt.hash(String(password), 10),
        role,
        is_super_admin: false,
        is_first_login: true,
        note,
        status,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      // ✅ Log activity
      await logActivity({
        title: `${document}ថ្មី ${fullName(saveData)} ត្រូវបានបង្កើត!`,
        description: `បង្កើតដោយគណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(201).json({ success: true, data: saveData, message: newSave });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== ROLES (dropdown) ================================================
  prop.app.get(`${urlAPI}-roles`, prop.api_auth, prop.jwt_auth, prop.request_user, (req, res) => {
    res.json({ success: true, data: USER_ROLES });
  });

  // ===================================== GET LIST (with filter + pagination) ================================================
  prop.app.get(`${urlAPI}`, ...guard, async (req, res) => {
    try {
      const result = await getFilteredMongoDB(req.query, UserModel, [], [notSuperAdmin]);
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL ================================================
  prop.app.get(`${urlAPI}-all`, ...guard, async (req, res) => {
    try {
      const result = await UserModel.find({ deleted: false, ...notSuperAdmin }).sort({ firstname: 1 });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  prop.app.get(`${urlAPI}/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const data = await UserModel.findOne({ _id: id, deleted: false, ...notSuperAdmin });
      if (!data) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      return res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: "Internal Error", error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  prop.app.put(`${urlAPI}/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      // ✅ Build update fields (password / flags are changed by their own routes)
      const updateFields = removeEmpty({
        ...sanitizeUpdate(req.body, ["password", "is_super_admin", "is_first_login"]),
        updated_by: userId,
      });

      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      if (updateFields.email !== undefined) {
        updateFields.email = String(updateFields.email).trim().toLowerCase();
        const exists = await UserModel.exists({ email: updateFields.email, deleted: false, _id: { $ne: id } });
        if (exists) {
          return res.status(409).json({ success: false, message: existsText });
        }
      }

      if (updateFields.role !== undefined && !USER_ROLES.includes(updateFields.role)) {
        return res.status(400).json({ success: false, message: roleInvalid });
      }

      if (String(id) === String(userId) && updateFields.status === false) {
        return res.status(400).json({ success: false, message: cannotSelf });
      }

      const updatedData = await UserModel.findOneAndUpdate(
        { _id: id, deleted: false, ...notSuperAdmin },
        updateFields,
        { returnDocument: "after", runValidators: true },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      // Suspended → log out everywhere
      if (updatedData.status === false) {
        await SessionModel.deleteMany({ user_id: updatedData._id });
      }

      delete updateFields.updated_by;
      await logActivity({
        title: `${document} ${fullName(updatedData)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(updateFields)}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: updatedData,
        message: updatedText(fullName(updatedData)),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESET PASSWORD (by admin) ================================================
  // body: { password }  → user must change it after next login
  prop.app.put(`${urlAPI}/reset-password/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      const requiredFields = [{ key: "password", label: "ពាក្យសម្ងាត់" }];
      if (!checkValidtion(res, req, requiredFields)) return;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }
      if (String(req.body.password).length < 8) {
        return res.status(400).json({ success: false, message: shortPassword });
      }

      const updatedData = await UserModel.findOneAndUpdate(
        { _id: id, deleted: false, ...notSuperAdmin },
        {
          password: await bcrypt.hash(String(req.body.password), 10),
          is_first_login: true,
          updated_by: userId,
        },
        { returnDocument: "after" },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      // ✅ Log out everywhere
      await SessionModel.deleteMany({ user_id: updatedData._id });

      await logActivity({
        title: `${document} ${fullName(updatedData)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកំណត់ពាក្យសម្ងាត់ឡើងវិញ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: updatedData,
        message: updatedText(fullName(updatedData)),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  prop.app.delete(`${urlAPI}/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }
      if (String(id) === String(userId)) {
        return res.status(400).json({ success: false, message: cannotSelf });
      }

      const updatedData = await UserModel.findOneAndUpdate(
        { _id: id, deleted: false, ...notSuperAdmin },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      await SessionModel.deleteMany({ user_id: updatedData._id });

      await logActivity({
        title: `${document} ${fullName(updatedData)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: `${document} ${fullName(updatedData)} បានលុប`,
        message: deletedText(fullName(updatedData)),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  prop.app.put(`${urlAPI}/restore/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const current = await UserModel.findOne({ _id: id, deleted: true, ...notSuperAdmin });
      if (!current) {
        return res.status(404).json({ success: false, message: noDataFound });
      }
      const exists = await UserModel.exists({ email: current.email, deleted: false });
      if (exists) {
        return res.status(409).json({ success: false, message: existsText });
      }

      current.deleted = false;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${fullName(current)} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: current,
        message: `${document} ${fullName(current)} បានស្តារឡើងវិញ!`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;

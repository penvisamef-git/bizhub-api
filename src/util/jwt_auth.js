const jwt = require("jsonwebtoken");

function getToken(req) {
  let token = req.headers["x-access-token"] || req.headers["authorization"];
  if (!token) return null;
  if (token.startsWith("Bearer ")) token = token.slice(7).trim();
  return token;
}

function jwt_auth(req, res, next) {
  try {
    const token = getToken(req);

    if (!token) {
      return res
        .status(401)
        .send({ success: false, message: "Unauthorized Permission" });
    }

    req.decode = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token;
    next();
  } catch (err) {
    return res
      .status(401)
      .send({ success: false, message: "Unauthorized Permission" });
  }
}

module.exports = {
  jwt_auth,
  getToken,
};

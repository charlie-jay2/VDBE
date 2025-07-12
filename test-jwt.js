import jwt from "jsonwebtoken";

const token = jwt.sign({ test: "data" }, "secret");
console.log(token);

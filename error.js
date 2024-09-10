const errorHandler = (err, req, res, next) => {
  const statusCode = res.statusCode == 200 ? 500 : res.statusCode;

  return res.status(statusCode).json({
    message: err.message,
  });
};

module.exports = errorHandler;
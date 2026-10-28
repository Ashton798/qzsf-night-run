'use strict';

const business = require('./business');

module.exports = async function stage2Handler(req, res) {
  const original = req.headers['x-vercel-original-path'] || req.url || '/';
  const url = new URL(original, 'https://local.invalid');
  if(!await business.handle(req, res, url)){res.statusCode=404;res.end();}
};

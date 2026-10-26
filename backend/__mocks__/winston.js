// Stub for winston — used in test environment where the package is not installed
const noop = () => {};
const transport = class { constructor() {} };
const logger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  verbose: noop,
};

// winston.format is both a factory (winston.format(fn)) and a namespace of formats
const format = Object.assign(() => () => ({}), {
  combine: () => ({}),
  timestamp: () => ({}),
  errors: () => ({}),
  json: () => ({}),
  colorize: () => ({}),
  printf: () => ({}),
});

const winston = {
  createLogger: () => logger,
  format,
  transports: {
    Console: transport,
    File: transport,
  },
};

export default winston;

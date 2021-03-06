'use strict';

const typeOf = require('jsmicro-typeof');
const foreach = require('jsmicro-foreach');

const Storage = require('./storage');
const factory = require('./helper/factory');

const { $merge } = require('./helper/object/merge');
const { $get } = require('./helper/object/get');
const { logger } = require('./helper/logger');
const { color } = logger;

/**
 * Context is a module to wrap services while calling them. With wrapping services, the running services
 * can have difference context on each runs. The services inside the context will have the same context.
 */
class Context {
    /**
     * Context Constructor
     * @description Create new context to call the given services.
     *
     * @param {Semen} main - Semen as the main object.
     * @param {ServiceStore} store - Service Store as the store.
     */
    constructor(main, store) {
        // Add the semen and service store as the main and store.
        this.main = main;
        this.store = store;

        // Create context id.
        this.id = new Date().getTime();

        // Set the mode to async by default.
        this.async = true;

        // Create the shared objects.
        this.sharing = new Storage({
            // Private properties.
            $context: this,
            $semen: main,
            $serviceStore: main.serviceStore,
            $configsStore: main.configsStore,

            // Public properties.
            helper: main.helper
        });

        // Create new Storage.
        this.storage = new Storage();

        // Create the services list.
        this.services = [];
    }

    /**
     * Context Services Getter
     *
     * @param {string|array} name - String service name, or array service names.
     * @returns {*}
     */
    get(name) {
        // Get single service if the name is a string.
        if ('string' === typeof name) {
            // Creating result holder.
            let result;

            // Iterate the available services in the context to match the service name.
            this.services.forEach(service => {
                // If the current service name is match with then requested name, then use it.
                if (service.name === name) {
                    result = service;
                }
            });

            // If no result, throw an error.
            if (!result) {
                this.errorStack = new Error(`Invalid Service: The context doesn't have service ${color.magenta(name)}!`);
                this.error();
            }

            return result;
        }

        // Get multiple services if the name is an array.
        else if (Array.isArray(name)) {
            // Create result holder.
            let result = [];

            // Iterate the names to get the name and get the service.
            name.forEach(name => {
                result.push(this.get(name));
            });

            return result;
        } else {
            this.errorStack = new Error(`Invalid Name: Getting context services require string or array for param "name"!`);
            this.error();
        }
    }

    /**
     * Insert service to the context.
     *
     * @param {Service|function} service - Service or function to insert it to the context.
     * @returns {Context}
     */
    insert(service) {
        if ('service' === typeOf(service)) {
            // Wrap the service before pushing to the list if the given service is a valid Service.
            this.services.push(service.wrap(this));
        } else if ('function' === typeof service) {
            // Directly push the service to services list if the given service is a function.
            this.services.push(service);
        }

        return this;
    }

    /**
     * Start the context to start the services.
     *
     * @param {boolean} [async=true] - Does the call is using async mode.
     * @returns {Context}
     */
    start(async = true) {
        // Change the async mode with the given mode.
        this.async = async;

        // Run the services in async mode.
        // This mode will simply iterates the services and run them.
        // The context will never capture the services runtime status.
        if (async) {
            // Iterate the services to get the service.
            this.services.forEach(service => {
                // Start the service if the current service is a valid Service.
                if ('service' === typeOf(service)) {
                    service.start();
                } else if ('function' === typeof service) {
                    // Resolve the params and call the service if the current service is a function.
                    let params = this.resolve(service);

                    // service.apply(service, params);
                    service(...params);
                }
            });

            // Mark the context as complete directly.
            this.complete();
        }

        // Run the services in sync
        // This mode will wait for first service to complete before running the next services.
        // This mode will refrelcted to the child services.
        else {
            // Iterate the service using custom iterator to support "next".
            foreach(this.services).run((i, service, next) => {
                // Create result holder.
                let result;

                if ('service' === typeOf(service)) {
                    // Start the service if the current service is a valid Service.
                    result = service.start();
                } else {
                    // Resolve the params can call the service if the current service is a function.
                    if ('function' === typeof service) {
                        let params = this.resolve(service);

                        // result = service.apply(service, params);
                        result = service(...params);
                    }
                }

                // Wait the process if the result is a promise.
                if (result && result.then) {
                    // Wait for the current service to complete before running the next services.
                    result.then(() => {
                        next();
                    });

                    // Throw the error if some errors happened during the service runs.
                    result.catch(err => {
                        this.errorStack = err;
                        this.error();
                    });
                } else {
                    // Start the next service if the result is not a promise.
                    next();
                }
            }).then(() => {
                this.complete();
            }).catch(err => {
                this.errorStack = err;
                this.error();
            });
        }

        return this;
    }

    /**
     * Start the context in synchronus mode.
     *
     * @returns {Context}
     */
    sync() {
        return this.start(false);
    }

    /**
     * Start the context in asynchronus mode.
     *
     * @returns {Context}
     */
    async() {
        return this.start(true);
    }

    /**
     * Resolve arguments of function from the execution context.
     *
     * @param {function} fn - Function to resolve the arguments.
     * @returns {Array}
     */
    resolve(fn, src) {
        let { main, store } = this;
        let { Logger, logger } = main.helper;

        // Create new factory.
        let fc = factory(fn);

        // Get the factory arguments names.
        let args = fc.args;

        let config = src ? src.configs : null;

        if (config) {
            if (Array.isArray(config)) {
                config.forEach((cfg, i) => {
                    if ('function' === typeof cfg.data) {
                        logger.debug(`Initializing config of ${color.magenta(`${cfg.name}@${cfg.version}`)}...`);

                        let params = this.resolve(cfg.data);

                        config[ i ].data = cfg.data.apply(cfg.data, params);
                    }
                });
            } else {
                if ('function' === typeof config.data) {
                    logger.debug(`Initializing config of ${color.magenta(`${config.name}@${config.version}`)}...`);

                    let params = this.resolve(config.data);

                    config.data = config.data.apply(config.data, params || []);
                }
            }
        }

        // Get the factory arguments value.
        let params = fc.parse([
            // Add the shared properties of Semen to the factory lookup.
            $get(main, [ 'sync', 'async', 'start', 'getConfig', 'getService', 'getClass', 'getHelper', 'resolve' ]),

            // Add the sharing object to the factory lookup.
            this.sharing.data,

            // Add the custom properties to the factory lookup.
            {
                storage: this.storage,
                storageData: this.storage.data,
                logger: new Logger($merge({}, logger.cfg, { prefix: src ? `${color.magenta(src.name)}@${color.yellow(src.version)}` : `${this.id}` })),
                color: logger.color,
                config
            }
        ]);

        // Check for unresolved params.
        params.forEach((value, i) => {
            // Esnure to resolve the unresolved params.
            if ('undefined' === typeof value) {
                // Try to get the value from service store.
                let result = store.get(args[ i ]);

                // If value is found on service store, use it.
                if ('undefined' !== typeof result) {
                    params[ i ] = result;
                }

                // Try to get the value from node_modules if value not found in service store.
                else {
                    try {
                        // If module found, uset.
                        params[ i ] = require(args[ i ]);
                    } catch (err) {
                        // Let it undefined if no module found.
                        return err;
                    }
                }
            }
        });

        return params;
    }

    /**
     * Add listener to handle the complete event.
     *
     * @param {function} fn - Function to handle when the process completed.
     * @returns {Context}
     */
    then(fn) {
        if ('function' === typeof fn) {
            this.finally = fn;
        }

        if (this.status === 'completed') {
            this.complete();
        }

        return this;
    }

    /**
     * Add listener to handle the error event.
     *
     * @param {function} fn - Function to handle when the process errored.
     * @returns {Context}
     */
    catch(fn) {
        if ('function' === typeof fn) {
            this.ehandle = fn;
        }

        if (this.status === 'errored') {
            this.error();
        }

        return this;
    }

    /**
     * Trigger the complete event and call the listener.
     *
     * @returns {Context}
     */
    complete() {
        if ('function' === typeof this.finally) {
            this.finally.call(this, this.storage);
            this.status = 'completed';
        }

        return this;
    }

    /**
     * Trigger the error event and call the listener.
     *
     * @returns {Context}
     */
    error() {
        if ('function' === typeof this.ehandle) {
            this.ehandle.call(this, this.errorStack);
        } else {
            throw this.errorStack;
        }

        this.status = 'errored';

        return this;
    }
}

// Exporting the Context constructor.
module.exports = Context;

var debug = require('debug')('koa-router');
var pathToRegExp = require('path-to-regexp');
var uri = require('urijs');

module.exports = Layer;

/**
 * Initialize a new routing Layer with given `method`, `path`, and `middleware`.
 *
 * @param {String|RegExp} path Path string or regular expression.
 * @param {Array} methods Array of HTTP verbs.
 * @param {Array} middleware Layer callback/middleware or series of.
 * @param {Object=} opts
 * @param {String=} opts.name route name
 * @param {String=} opts.sensitive case sensitive (default: false)
 * @param {String=} opts.strict require the trailing slash (default: false)
 * @returns {Layer}
 * @private
 */

function Layer(path, methods, middleware, opts) {
    this.opts = opts || {};
    // 路由命名
    this.name = this.opts.name || null;
    // 路由对应的方法
    this.methods = [];
    // 路由参数名数组
    this.paramNames = [];
    // 路由处理中间件数组 注意这里的 stack 和 Router 里面的 stack 是不一样的, Router 的 stack 数组是存放每个路由对应的 Layer 实例对象的, 而 Layer 实例对象里面的 stack 数组是存储每个路由的处理函数中间件的, 换言之, 一个路由可以添加多个处理函数。
    this.stack = Array.isArray(middleware) ? middleware : [middleware];
    // 存储路由方法
    methods.forEach(function (method) {
        var l = this.methods.push(method.toUpperCase());
        if (this.methods[l - 1] === 'GET') {
            this.methods.unshift('HEAD'); // HEAD 方法与 GET 方法基本是一致的, 所以 koa-router 在处理 GET 请求的时候顺带将 HEAD 请求一并处理, 因为两者的区别在于 HEAD 请求不响应数据体。
        }
    }, this);

    // ensure middleware is a function 确保中间件是函数
    this.stack.forEach(function (fn) {
        var type = (typeof fn);
        if (type !== 'function') {
            throw new Error(
                methods.toString() + " `" + (this.opts.name || path) + "`: `middleware` " +
                "must be a function, not `" + type + "`"
            );
        }
    }, this);

    this.path = path;
    this.regexp = pathToRegExp(path, this.paramNames, this.opts); // 路由匹配引擎根据path生成匹配正则，param变量添加到this.paramNames数组中

    debug('defined route %s %s', this.methods, this.opts.prefix + this.path);
};

/**
 * Returns whether request `path` matches route.
 *
 * @param {String} path
 * @returns {Boolean}
 * @private
 */

Layer.prototype.match = function (path) {
    return this.regexp.test(path);
};

/**
 * Returns map of URL parameters for given `path` and `paramNames`.
 *
 * @param {String} path
 * @param {Array.<String>} captures
 * @param {Object=} existingParams
 * @returns {Object}
 * @private
 */

Layer.prototype.params = function (path, captures, existingParams) {
    var params = existingParams || {};

    for (var len = captures.length, i = 0; i < len; i++) {
        if (this.paramNames[i]) {
            var c = captures[i];
            params[this.paramNames[i].name] = c ? safeDecodeURIComponent(c) : c;
        }
    }

    return params;
};

/**
 * Returns array of regexp url path captures.
 *
 * @param {String} path
 * @returns {Array.<String>}
 * @private
 */

Layer.prototype.captures = function (path) {
    if (this.opts.ignoreCaptures) return [];
    return path.match(this.regexp).slice(1);
};

/**
 * Generate URL for route using given `params`.
 *
 * @example
 *
 * ```javascript
 * var route = new Layer(['GET'], '/users/:id', fn);
 *
 * route.url({ id: 123 }); // => "/users/123"
 * ```
 *
 * @param {Object} params url parameters
 * @returns {String}
 * @private
 */

Layer.prototype.url = function (params, options) {
    var args = params;
    var url = this.path.replace(/\(\.\*\)/g, '');
    var toPath = pathToRegExp.compile(url);
    var replaced;

    if (typeof params != 'object') {
        args = Array.prototype.slice.call(arguments);
        if (typeof args[args.length - 1] == 'object') {
            options = args[args.length - 1];
            args = args.slice(0, args.length - 1);
        }
    }

    var tokens = pathToRegExp.parse(url);
    var replace = {};

    if (args instanceof Array) {
        for (var len = tokens.length, i = 0, j = 0; i < len; i++) {
            if (tokens[i].name) replace[tokens[i].name] = args[j++];
        }
    } else if (tokens.some(token => token.name)) {
        replace = params;
    } else {
        options = params;
    }

    replaced = toPath(replace);

    if (options && options.query) {
        var replaced = new uri(replaced)
        replaced.search(options.query);
        return replaced.toString();
    }

    return replaced;
};

/**
 * Run validations on route named parameters.
 *
 * @example
 *
 * ```javascript
 * router
 *   .param('user', function (id, ctx, next) {
 *     ctx.user = users[id];
 *     if (!user) return ctx.status = 404;
 *     next();
 *   })
 *   .get('/users/:user', function (ctx, next) {
 *     ctx.body = ctx.user;
 *   });
 * ```
 *
 * @param {String} param
 * @param {Function} middleware
 * @returns {Layer}
 * @private
 */

Layer.prototype.param = function (param, fn) {
    var stack = this.stack;
    var params = this.paramNames;
    var middleware = function (ctx, next) {
        return fn.call(this, ctx.params[param], ctx, next);
    };
    middleware.param = param;

    var names = params.map(function (p) {
        return p.name;
    });

    var x = names.indexOf(param);
    if (x > -1) {
        // iterate through the stack, to figure out where to place the handler fn
        stack.some(function (fn, i) {
            // param handlers are always first, so when we find an fn w/o a param property, stop here
            // if the param handler at this part of the stack comes after the one we are adding, stop here
            if (!fn.param || names.indexOf(fn.param) > x) {
                // inject this param handler right before the current item
                stack.splice(i, 0, middleware);
                return true; // then break the loop
            }
        });
    }

    return this;
};

/**
 * Prefix route path.
 *
 * @param {String} prefix
 * @returns {Layer}
 * @private
 */

Layer.prototype.setPrefix = function (prefix) {
    if (this.path) {
        this.path = prefix + this.path;
        this.paramNames = [];
        this.regexp = pathToRegExp(this.path, this.paramNames, this.opts);
    }

    return this;
};

/**
 * Safe decodeURIComponent, won't throw any error.
 * If `decodeURIComponent` error happen, just return the original value.
 *
 * @param {String} text
 * @returns {String} URL decode original string.
 * @private
 */

function safeDecodeURIComponent(text) {
    try {
        return decodeURIComponent(text);
    } catch (e) {
        return text;
    }
}
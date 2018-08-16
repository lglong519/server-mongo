let express = require('express');
let path = require('path');
let logger = require('morgan');
let cookieParser = require('cookie-parser');
let bodyParser = require('body-parser');
let handlebars = require('express-handlebars');
let nconf = require('nconf');
let session = require('express-session');
let async = require('async');
let moment = require('moment');
let fs = require('fs');

// Define routes
let indexRoute = require('./routes/index');
let apiRoute = require('./routes/api');
let usersRoute = require('./routes/users');
let configRoute = require('./routes/config');
let docRoute = require('./routes/document');
let dbRoute = require('./routes/database');
let collectionRoute = require('./routes/collection');

// set the base dir to __dirname when running as webapp and electron path if running as electron app
let dir_base = __dirname;
if (process.versions.electron) {
	dir_base = path.join(process.resourcesPath.toString(), 'app/');
}

let app = express();

// setup the translation
let i18n = new (require('i18n-2'))({
	extension: '.json',
	locales: ['en', 'de', 'es', 'ru', 'zh-cn'],
	directory: path.join(dir_base, 'locales/')
});
i18n.setLocale('zh-cn');
// setup DB for server stats
let Datastore = require('nedb');
let db = new Datastore({ filename: path.join(dir_base, 'data/dbStats.db'), autoload: true });

// view engine setup
app.set('views', path.join(dir_base, 'views/'));
app.engine('hbs', handlebars({ extname: 'hbs', defaultLayout: path.join(dir_base, 'views/layouts/layout.hbs') }));
app.set('view engine', 'hbs');

// Check existence of backups dir, create if nothing
if (!fs.existsSync(path.join(dir_base, 'backups'))) fs.mkdirSync(path.join(dir_base, 'backups'));

// helpers for the handlebars templating platform
handlebars = handlebars.create({
	helpers: {
		__ (value) {
			return i18n.__(value);
		},
		toJSON (object) {
			return JSON.stringify(object);
		},
		niceBool (object) {
			if (object === undefined) return 'No';
			if (object === true) return 'Yes';
			return 'No';
		},
		app_context () {
			if (nconf.stores.app.get('app:context') !== undefined) {
				return `/${nconf.stores.app.get('app:context')}`;
			} return '';
		},
		ifOr (v1, v2, options) {
			return v1 || v2 ? options.fn(this) : options.inverse(this);
		},
		ifNotOr (v1, v2, options) {
			return v1 || v2 ? options.inverse(this) : options.fn(this);
		},
		formatBytes (bytes) {
			if (bytes === 0) return '0 Byte';
			let k = 1000;
			let decimals = 2;
			let dm = decimals + 1 || 3;
			let sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
			let i = Math.floor(Math.log(bytes) / Math.log(k));
			return `${(bytes / Math.pow(k, i)).toPrecision(dm)} ${sizes[i]}`;
		},
		formatDuration (time) {
			return moment.duration(time, 'seconds').humanize();
		}
	}
});

// setup nconf to read in the file
// create config dir and blank files if they dont exist
let dir_config = path.join(dir_base, 'config/');
let config_connections = path.join(dir_config, 'config.json');
let config_app = path.join(dir_config, 'app.json');

// Check existence of config dir and config files, create if nothing
if (!fs.existsSync(dir_config)) fs.mkdirSync(dir_config);

// The base of the /config/app.json file, will check against environment values
let configApp = {
	app: {}
};
if (process.env.HOST) configApp.app.host = process.env.HOST;
if (process.env.PORT) configApp.app.port = process.env.PORT;
if (process.env.PASSWORD) configApp.app.password = process.env.PASSWORD;
if (process.env.LOCALE) configApp.app.locale = process.env.LOCALE;
if (process.env.CONTEXT) configApp.app.context = process.env.CONTEXT;
if (process.env.MONITORING) configApp.app.monitoring = process.env.MONITORING;

if (!fs.existsSync(config_app)) fs.writeFileSync(config_app, JSON.stringify(configApp));

// Check the env for a connection to initiate
let configConnection = {
	connections: {}
};
if (process.env.CONN_NAME && process.env.DB_HOST) {
	if (!process.env.DB_PORT) process.env.DB_PORT = '27017'; // Use the default mongodb port when DB_PORT is not set
	let connectionString = 'mongodb://';
	if (process.env.DB_USERNAME && process.env.DB_PASSWORD && process.env.DB_NAME) {
		connectionString += `${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
	} else if (process.env.DB_USERNAME && process.env.DB_PASSWORD) {
		connectionString += `${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/`;
	} else {
		connectionString += `${process.env.DB_HOST}:${process.env.DB_PORT}`;
	}
	configConnection.connections[process.env.CONN_NAME] = {
		connection_options: {},
		connection_string: connectionString
	};
}
if (!fs.existsSync(config_connections) || fs.readFileSync(config_connections, 'utf8') === '{}') fs.writeFileSync(config_connections, JSON.stringify(configConnection));

// if config files exist but are blank we write blank files for nconf
if (fs.existsSync(config_app, 'utf8')) {
	if (fs.readFileSync(config_app, 'utf8') === '') {
		fs.writeFileSync(config_app, '{}', 'utf8');
	}
}
if (fs.existsSync(config_connections, 'utf8')) {
	if (fs.readFileSync(config_connections, 'utf8') === '') {
		fs.writeFileSync(config_connections, '{}', 'utf8');
	}
}

// setup the two conf. 'app' holds application config, and connections
// holds the mongoDB connections
nconf.add('connections', { type: 'file', file: config_connections });
nconf.add('app', { type: 'file', file: config_app });

// set app defaults
let app_host = process.env.HOST || '127.0.0.1';
let app_port = process.env.PORT || 1234;

// get the app configs and override if present
if (nconf.stores.app.get('app:host') !== undefined) {
	app_host = nconf.stores.app.get('app:host');
}
if (nconf.stores.app.get('app:port') !== undefined) {
	app_port = nconf.stores.app.get('app:port');
}
if (nconf.stores.app.get('app:locale') !== undefined) {
	i18n.setLocale(nconf.stores.app.get('app:locale'));
}

app.locals.app_host = app_host;
app.locals.app_port = app_port;

// setup the app context
let app_context = '';
if (nconf.stores.app.get('app:context') !== undefined) {
	app_context = `/${nconf.stores.app.get('app:context')}`;
}

app.use(logger('dev'));
app.use(bodyParser.json({ limit: '16mb' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

// setup session
app.use(session({
	secret: '858SGTUyX8w1L6JNm1m93Cvm8uX1QX2D',
	resave: true,
	saveUninitialized: true
}));

// front-end modules loaded from NPM
app.use(`${app_context}/static`, express.static(path.join(dir_base, 'public/')));
app.use(`${app_context}/font-awesome`, express.static(path.join(dir_base, 'node_modules/font-awesome/')));
app.use(`${app_context}/jquery`, express.static(path.join(dir_base, 'node_modules/jquery/dist/')));
app.use(`${app_context}/bootstrap`, express.static(path.join(dir_base, 'node_modules/bootstrap/dist/')));
app.use(`${app_context}/css`, express.static(path.join(dir_base, 'public/css')));
app.use(`${app_context}/fonts`, express.static(path.join(dir_base, 'public/fonts')));
app.use(`${app_context}/js`, express.static(path.join(dir_base, 'public/js')));
app.use(`${app_context}/favicon.ico`, express.static(path.join(dir_base, 'public/favicon.ico')));

// Make stuff accessible to our router
app.use((req, res, next) => {
	req.nconf = nconf.stores;
	req.handlebars = handlebars;
	req.i18n = i18n;
	req.app_context = app_context;
	req.db = db;
	next();
});

// add context to route if required
if (app_context !== '') {
	app.use(app_context, apiRoute);
	app.use(app_context, usersRoute);
	app.use(app_context, configRoute);
	app.use(app_context, docRoute);
	app.use(app_context, dbRoute);
	app.use(app_context, collectionRoute);
	app.use(app_context, indexRoute);
} else {
	app.use('/', apiRoute);
	app.use('/', usersRoute);
	app.use('/', configRoute);
	app.use('/', docRoute);
	app.use('/', dbRoute);
	app.use('/', collectionRoute);
	app.use('/', indexRoute);
}

// catch 404 and forward to error handler
app.use((req, res, next) => {
	let err = new Error('Not Found');
	err.status = 404;
	next(err);
});

// === Error handlers ===

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
	app.use((err, req, res, next) => {
		console.log(err.stack);
		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err,
			helpers: handlebars.helpers
		});
	});
}

// production error handler
// no stacktraces leaked to user
app.use((err, req, res, next) => {
	console.log(err.stack);
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {},
		helpers: handlebars.helpers
	});
});

app.on('uncaughtException', err => {
	console.error(err.stack);
	process.exit();
});

// add the connections to the connection pool
let connection_list = nconf.stores.connections.get('connections');
let connPool = require('./connections');
let monitoring = require('./monitoring');
app.locals.dbConnections = null;

async.forEachOf(
	connection_list, (value, key, callback) => {
		let MongoURI = require('mongo-uri');

		try {
			MongoURI.parse(value.connection_string);
			connPool.addConnection({ connName: key, connString: value.connection_string, connOptions: value.connection_options }, app, (err, data) => {
				if (err) {
					console.log(err);
					delete connection_list[key];
				}
				callback();
			});
		} catch (err) {
			callback();
		}
	},
	err => {
		if (err) console.error(err.message);
		// lift the app
		app.listen(app_port, app_host, () => {
			console.log(`adminMongo listening on host: http://${app_host}:${app_port}${app_context}`);

			// used for electron to know when express app has started
			app.emit('startedAdminMongo');

			if (nconf.stores.app.get('app:monitoring') !== false) {
				// start the initial monitoring
				monitoring.serverMonitoring(db, app.locals.dbConnections);

				// Keep firing monitoring every 30 seconds
				setInterval(() => {
					monitoring.serverMonitoring(db, app.locals.dbConnections);
				}, 30000);
			}
		}).on('error', err => {
			if (err.code === 'EADDRINUSE') {
				console.error(`Error starting adminMongo: Port ${app_port} already in use, choose another`);
			} else {
				console.error(`Error starting adminMongo: ${err}`);
				app.emit('errorAdminMongo');
			}
		});
	}
);

module.exports = app;

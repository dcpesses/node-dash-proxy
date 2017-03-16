// #!/usr/bin/env node;
//
//
// require('babel-register');
// require('babel-core/register')({
//     presets: ["es2015"]
// });

var path = require('path');
var fs = require('fs');
var time = require('time');
const logging = require('log4js');
var argparse = require('argparse');
var request = require('request');
var elementtree = require('elementtree');
var copy = require('copy');
var mkdirp = require('mkdirp');

// const format = require('python-format');
const format = function(str, data) {
	var re = /{([^{}]+)}/g;

	return str.replace(/{([^{}]+)}/g, function(match, val) {
		var prop = data;
		val.split('.').forEach(function(key) {
			prop = prop[key];
		});

		return prop;
	});
};
// var colored = require('colored');


logging.VERBOSE = Math.floor((logging.INFO + logging.DEBUG));
// logging.configure({
// 	encoding: "ascii"
// })

const logger = logging.getLogger('dash-proxy');
logger.setLevel(logging.VERBOSE);
// logger.addHandler(logging.StreamHandler());


const ns = {'mpd':'urn:mpeg:dash:schema:mpd:2011'};


/*
class Formatter extends logging.Formatter {
    constructor(fmt=null, datefmt=null) {
        super(Formatter, self).__init__(fmt, datefmt);
    }
    format(record) {
		return record.msg;
        col|| = null;
        // if (record.levelno == logging.ERROR) {
        //     col|| = 'red';
        // }
        // if (record.levelno == logging.INFO) {
        //     col|| = 'green';
        // }
        // if (record.levelno == logging.WARNING) {
        //     col|| = 'yellow';
        // }
        // if (color) {
        //     return colored(record.msg, color);
        // } else {
        //     return record.msg;
        // }
    }
}
*/

// var ch = logging.StreamHandler();
//     ch.setLevel(logging.DEBUG);
//
// var formatter = new Formatter();
//     ch.Formatter = formatter;
//
// logger.addHandler(ch);



class RepAddr extends Object {
    constructor(period_idx, adaptation_set_idx, representation_idx) {
        super(period_idx, adaptation_set_idx, representation_idx);
        this.period_idx = period_idx;
        this.adaptation_set_idx = adaptation_set_idx;
        this.representation_idx = representation_idx;
    }
    toString() {
        ///return 'Representation (period=%d adaptation-set=%d representation=%d)', (this.period_idx, this.adaptation_set_idx, this.representation_idx);
        return 'Representation (period=' + this.period_idx + ' adaptation-set='+this.adaptation_set_idx+' representation='+this.representation_idx+')';
    }
};

class MpdLocator extends Object {
    constructor(mpd) {
        super(mpd);
        this.mpd = mpd;
        this.base_url = this.base_url.bind(this);
        this.representation = this.representation.bind(this);
        this.segment_template = this.segment_template.bind(this);
        this.segment_timeline = this.segment_timeline.bind(this);
        this.adaptation_set = this.adaptation_set.bind(this);
    }
    base_url(rep_addr) {
        return this.mpd.findall('Period')[rep_addr.period_idx].find('BaseURL');
    }
    representation(rep_addr) {
        return this.adaptation_set(rep_addr).findall('Representation')[rep_addr.representation_idx];
    }
    segment_template(rep_addr) {
        let rep_st = this.representation(rep_addr).find('SegmentTemplate');
        if (rep_st !== null) {
            return rep_st;
        } else {
            return this.adaptation_set(rep_addr).find('SegmentTemplate');
        }
    }
    segment_timeline(rep_addr) {
        return this.segment_template(rep_addr).find('SegmentTimeline');
    }
    adaptation_set(rep_addr) {
        return this.mpd.findall('Period')[rep_addr.period_idx].findall('AdaptationSet')[rep_addr.adaptation_set_idx];
    }
}

class HasLogger extends Object {
    constructor() {
        super();
		this.verbose = this.verbose.bind(this);
		this.info = this.info.bind(this);
		this.debug = this.debug.bind(this);
		this.warning = this.warning.bind(this);
		this.error = this.error.bind(this);
    }
    verbose(msg) {
        this.logger.log(logging.VERBOSE, msg);
    }
    info(msg) {
        this.logger.log(logging.INFO, msg);
    }
    debug(msg) {
        this.logger.log(logging.DEBUG, msg);
    }
    warning(msg) {
        this.logger.log(logging.WARNING, msg);
    }
    error(msg) {
        this.logger.log(logging.ERROR, msg);
    }
}

class DashProxy extends HasLogger {
    constructor(mpd, output_dir, download, save_mpds=false) {
        super(mpd, output_dir, download, save_mpds=false);
        this.logger = logger;
        this.mpd = mpd;
        this.output_dir = output_dir;
        this.download = download;
        this.save_mpds = save_mpds;
        this.i_refresh = 0;
        this.downloaders = {};
        this.retry_interval = 10;
		this.subfolder = '';

        this.run = this.run.bind(this);
        this.refresh_mpd = this.refresh_mpd.bind(this);
        this.get_base_url = this.get_base_url.bind(this);
        this.handle_mpd_tree = this.handle_mpd_tree.bind(this);
        this.ensure_downloader = this.ensure_downloader.bind(this);
        this.write_output_mpd = this.write_output_mpd.bind(this);
    }
    run() {
        // this.logger.log(logging.INFO, 'Running dash proxy for stream %s. Output goes in %s', (this.mpd, this.output_dir));
		this.logger.log(logging.INFO, 'Running dash proxy for stream '+this.mpd+'. Output goes in '+this.output_dir);
        this.refresh_mpd();
    }
    refresh_mpd(after=0) {
        this.i_refresh += 1;
        if (after>0) {
            time.sleep(after);
        }
		let _logger = this.logger;
        let _handle_mpd_tree = this.handle_mpd_tree.bind(this);
		let _output_dir = this.output_dir;
		let inc = (!this.i_refresh ? '-' : this.i_refresh);
        let r = request.get(this.mpd, function(error, resp, body) {
            if (error) {
                console.log(error);
            } else if (resp.status_code < 200 || resp.status_code >= 300) {
                // this.logger.log(logging.WARNING, 'Cannot GET the MPD. Server returned %s. Retrying after %ds', (resp.status_code, retry_interval));
				_logger.log(logging.WARNING, 'Cannot GET the MPD. Server returned '+resp.status_code+'. Retrying after '+retry_interval);
                this.refresh_mpd(retry_interval);
            } else {
				// create & save to dir
				_logger.log(logging.INFO, 'Creating output directory');
				mkdirp.sync(_output_dir);
				_logger.log(logging.INFO, 'Saving source MPD file');
				let mpdfile = 'manifest.'+inc+'.mpd';
		        let dest = path.join(_output_dir, mpdfile);

		        let fs = require('fs');
		        fs.writeFile(dest, body, function(err) {
		            if (err) {
		                console.log(err);
		            } else {
		                _logger.log(logging.ERROR, mpdfile+' saved.');
		            }
		        });


                //console.log(resp.statusCode) // 200
                //console.log(resp.headers['content-type'])
                elementtree.register_namespace('', ns['mpd']);
                //console.log(body);
                let mpd = elementtree.parse(body);
                _handle_mpd_tree(mpd);
            }
        });
    }
    get_base_url(mpd) {

        let baseUrl = function (url) {
            let idx = url.lastIndexOf('/');
            if (idx >= 0) {
                return url.slice(0,idx+1);  // url[:idx+1];
            }
            return url;
        };

        let base_url = baseUrl(this.mpd);
        let location = mpd.find('Location');    //find('mpd:Location', ns);
        if (location !== null) {
            base_url = baseUrl(location.text);
        }
		// console.log(base_url);
        let baseUrlNode = mpd.find('BaseUrl'); //find('mpd:BaseUrl', ns)
        if (baseUrlNode) {
            if (baseUrlNode.text.startswith('http://') || baseUrlNode.text.startswith('https://')) {
                base_url = baseUrl(baseUrlNode.text);
            } else {
                base_url += baseUrlNode.text;
            }
        }
		// console.log(base_url);
        return base_url;
    }
    handle_mpd_tree(mpd) {
        let original_mpd = Object.assign(mpd);
        // console.log(original_mpd);
        let periods = mpd.findall('Period');    //mpd.findall('mpd:Period', ns);
        this.logger.log(logging.INFO, 'mpd='+periods);
        this.logger.log(logging.VERBOSE, 'Found '+periods.length+' periods choosing the 1st one');
        // console.log("\n", 'Periods: ', periods);
        let period = periods[0];
        let adaptation_sets = period.findall('AdaptationSet');  //('mpd:AdaptationSet', ns);
        // console.log("\n", 'AdaptationSets: ', adaptation_sets);
        for (let [as_idx, adaptation_set] of adaptation_sets.entries()) {
            let representations = adaptation_set.findall('Representation');  //('mpd:Representation', ns);
            // console.log("\n", 'Representations: ', representations);
            for (let [rep_idx, representation] of representations.entries()) {
				// console.log("\n", 'rep_idx: ', rep_idx);
				// console.log("\n", 'representation: ', representation);
				// console.log("\n", 'representation[\'attrib\']: ', representation['attrib']);
				this.logger.log(logging.VERBOSE, 'Found representation with id ' + (!representation['attrib'] || !representation['attrib']['id'] ? 'UKN' : representation.attrib.id));
                // console.log("\n", 'VERBOSE: Found representation with id', (!representation.id ? 'UKN' : representation.id));   //attrib.get('id', 'UKN')
                // console.log("\n", 'as_idx: ', as_idx, "\n", 'rep_idx: ', rep_idx);
                let rep_addr = new RepAddr(0, as_idx, rep_idx);
                this.ensure_downloader(mpd, rep_addr);
            }
        }
        this.write_output_mpd(original_mpd);
        let minimum_update_period = (!mpd['attrib'] || !mpd['attrib']['minimumUpdatePeriod'] ? '' : mpd.attrib.minimumUpdatePeriod); //.attrib.get('minimumUpdatePeriod', '');
        if (minimum_update_period) {
            // TODO parse minimum_update_period
            this.refresh_mpd(10);   //after=10
        } else {
            this.info('VOD MPD. Nothing more to do. Stopping...');
        }
    }

    ensure_downloader(mpd, rep_addr) {

        // console.log('ensure_downloader - rep_addr: ', rep_addr);

        if (rep_addr in this.downloaders) {
            this.verbose('A downloader for ' + rep_addr.toString() + ' already started');
        } else {
            this.info('Starting a downloader for ' + rep_addr.toString());
            let downloader = new DashDownloader(this, rep_addr);
            this.downloaders[rep_addr] = downloader;
            // console.log('ensure_downloader - downloaders: ', this.downloaders);

			let baseUrlNode = mpd.find('BaseUrl');
			if (baseUrlNode) {
	            //baseUrlNode.text
            	// console.log("\n", baseUrlNode.text, "\n");
			} else {
				// console.log("\n", mpd, "\n");
			}

            downloader.handle_mpd(mpd, this.get_base_url(mpd));
        }
    }
    write_output_mpd(mpd) {
        this.info('Writing the update MPD file');
        // let content = elementtree.tostring(mpd, encoding='utf-8').decode('utf-8');
        let content = elementtree.tostring(mpd, {'encoding':'utf-8'});  //.decode('utf-8');
        // let content = elementtree.tostring(mpd);
        let dest = path.join(this.output_dir, 'manifest.mpd');

        let fs = require('fs');
		let _info = this.info.bind(this);
		let _error = this.error.bind(this);
        fs.writeFile(dest, content, function(err) {
            if (err) {
                _error(err);
            } else {
                _info('Write operation complete.');
            }
        });

        if (this.save_mpds) {
            // dest = path.join(this.output_dir, 'manifest.{}.mpd'.format(this.i_refresh));
			dest = format(path.join(this.output_dir, 'manifest.{}.mpd'), this.i_refresh);
            let fs = require('fs');
            fs.writeFile(dest, content, function(err) {
                if (err) {
                    _error(err);
                } else {
                    _info('save_mpds: Write operation complete.');
                }
            });
        }
    }
}
class DashDownloader extends HasLogger {

    constructor(proxy, rep_addr) {
        super(proxy, rep_addr);
        this.logger = logger;
        this.proxy = proxy;
        this.rep_addr = rep_addr;
        this.mpd_base_url = '';
        this.initialization_downloaded = false;
		this.subfolder = '';

        this.handle_mpd = this.handle_mpd.bind(this);
        this.download_template = this.download_template.bind(this);
        this.render_template = this.render_template.bind(this);
        this.full_url = this.full_url.bind(this);
        this.write_file = this.write_file.bind(this);
        // console.log("\n", 'constructor-  this.rep_addr: ', rep_addr, "\n");
    }

    handle_mpd(mpd, base_url) {
        this.mpd_base_url = base_url;
        this.mpd = new MpdLocator(mpd);
        // console.log("\n", 'this.mpd: ', this.mpd);
        // console.log("\n", 'this.rep_addr: ', this.rep_addr);
        let rep = this.mpd.representation(this.rep_addr);
        let subdir = this.mpd.base_url(this.rep_addr);
		subdir = (subdir) ? subdir.text : null;
        // console.log("\n", '<BaseURL>: ', subdir);
        this.info('subdir = ' + subdir);
		let output_path = (subdir) ? path.join(this.proxy.output_dir, subdir) : this.proxy.output_dir;

		// let permissions = parseInt('0755', 8);
		mkdirp.sync(output_path);
		// fs.mkdirSync(path.resolve(output_path), permissions);
		this.logger.log(logging.VERBOSE, 'Created dir:', output_path);


        let segment_template = this.mpd.segment_template(this.rep_addr);
        let segment_timeline = this.mpd.segment_timeline(this.rep_addr);
        let initialization_template = (!segment_template['attrib'] || !segment_template['attrib']['initialization'] ? '' : segment_template.attrib.initialization); // segment_template.attrib.get('initialization', '');
        if (initialization_template && !this.initialization_downloaded) {
            this.initialization_downloaded = true;
            this.download_template(initialization_template, rep, null, subdir, true);
        }
        let segments = Object.assign(segment_timeline.findall('S'));
        let idx = 0;

        // python polyfill
        function range(start, end, step) {
            var _end = end || start;
            var _start = end ? start : 0;
            var _step = step || 1;
            return Array((_end - _start) / _step).fill(0).map((v, i) => _start + (i * _step));
        }

        for (let segment of segments.entries()) {
            let duration = Number( !segment['attrib'] || !segment['attrib']['d'] ? 0 : segment.attrib.d );  // segment.attrib.get('d', '0')
            let repeat = Number( !segment['attrib'] || !segment['attrib']['r'] ? 0 : segment.attrib.r );    // segment.attrib.get('r', '0')
            idx = idx + 1;
            for (let _ of range(0, repeat)) {
				// elem = elementtree.Element('{urn:mpeg:dash:schema:mpd:2011}S', attrib={'d':duration});
                elem = elementtree.Element('S', {'d':duration});
                segment_timeline.insert(idx, elem);
                this.verbose('appding a new elem');
                idx = idx + 1;
            }
        }
		// console.log('segment_template:', segment_template);
		// console.log('segment_template[\'media\']:', segment_template.media);
        let media_template = (segment_template['attrib'] && segment_template['attrib']['media'] ? segment_template['attrib']['media'] : '');
        let next_time = 0;
        for (let segment of segment_timeline.findall('S')) {
			// console.log(segment[0]);
			// console.log('segment.get(\'t\'):', (!!segment.get('t')) ? segment.get('t') : -1);
			let _ctime = (!!segment.get('t')) ? segment.get('t') : -1;
            let current_time = Number(_ctime);
            if (current_time == -1) {
				segment['attrib'] = segment['attrib'] || {};
                segment['attrib']['t'] = next_time;
            } else {
                next_time = current_time;
            }
			let _time = (segment['attrib'] && segment['attrib']['d']) ? segment.attrib['d'] : 0;
			// console.log('_ctime:', _ctime, '_time:', _time, 'segment:', segment);
            next_time += Number(_time);
            this.download_template(media_template, rep, segment, subdir);
        }
    }

    download_template(template, representation=null, segment=null, subdir=null, flag_mkdir=false) {
        let dest = this.render_template(template, representation, segment);
        let dest_url = this.full_url(dest);
		let _write_file = this.write_file.bind(this);



		if (subdir) dest = subdir + dest;

		// create subdirs if neccessary
		if (flag_mkdir===true && dest.indexOf('/')>=0) {
			let subfolders = path.join(this.proxy.output_dir, dest.substr(0, dest.lastIndexOf('/')+1));
			this.info('creating folder path '+subfolders);
			mkdirp.sync(subfolders);
		}

        this.info('requesting '+dest);
		let _error = this.error.bind(this);
        let r = request.get(dest_url, function(error, resp, body) {
	        if (resp.statusCode >= 200 && resp.statusCode < 300) {
				// console.log(resp);
	            // this.write(dest, r.content);
	            _write_file(dest, body);
	        } else {
	            _error('cannot download '+dest_url+' server returned ' +resp.status_code);
				// console.log('cannot download '+dest_url+' server returned ' +resp.statusCode);
				// console.log(error);
	        }
		});

    }

    render_template(template, representation=null, segment=null, subdir=null) {
		// console.log("\n", 'template:', template);
        template = template.replace('$RepresentationID$', '{representation_id}');
		template = template.replace('$Time$', '{time}');
		template = template.replace('$Bandwidth$', '{bandwidth}');
        let args = {};
        if (representation !== null) {
            args['representation_id'] = (
				!representation['attrib'] || !representation['attrib']['id']
					? ''
					: representation.attrib['id']
				);
			args['bandwidth'] = (
				!representation['attrib'] || !representation['attrib']['bandwidth']
					? '0'
					: representation.attrib['bandwidth']
				);
			// console.log('representation is set');
        } else {
			// console.log('representation is null');
		}
        if (segment !== null) {
            args['time'] = (
				!segment['attrib'] || !segment['attrib']['t']
					? ''
					: segment.attrib['t']
				);
			// console.log('time is set');
        } else {
			// console.log('time is null');
		}
        // template = template.format(args);
		template = format(template, args);
        return template;
    }

	static format(str, data) {
		var re = /{([^{}]+)}/g;

		return str.replace(/{([^{}]+)}/g, function(match, val) {
			var prop = data;
			val.split('.').forEach(function(key) {
				prop = prop[key];
			});

			return prop;
		});
	}

    full_url(dest) {
        return this.mpd_base_url + dest;
    }

    write_file(dest, content) {
		let _dest = dest;
		let _pos = dest.indexOf('?')==-1 ? dest.length : dest.indexOf('?');
        dest = dest.slice(0, _pos); //dest[0:dest.rfind('?')];
		// console.log('dest',dest);
        dest = path.join(this.proxy.output_dir, dest);
        // let f = open(dest, 'wb');
        // f.write(content);
        // f.close();
		// console.log('Writing', _dest);
		this.logger.log(logging.INFO, 'Writing '+_dest);
		let _logger = this.logger;
        let fs = require('fs');
        fs.writeFile(dest, content, function(err) {
             if (err) {
                 _logger.log(logging.ERROR, _dest+': Error writing file:', err);
             } else {
                 _logger.log(logging.INFO, _dest+': Write operation complete.');

             }
        });
    }
}

function run(args) {
    let _level = (args.v) ? logging.INFO : logging.VERBOSE;
    logger.setLevel(_level);
    let proxy = new DashProxy(
        args['mpd'],   //mpd
        args['o'],     //output_dir
        args['d'],     //download
        args['save_individual_mpds']   //save_mpds
    );
    return proxy.run();
}

function main() {
    let parser = argparse.ArgumentParser();
    parser.addArgument('mpd', {help: 'URL of the MPEG-DASH stream to download / cache.'});
    parser.addArgument('-v', {action:'storeTrue', help: 'Verbose mode'});
    parser.addArgument('-d', {action:'storeTrue', help: 'Saves the cached stream in the output directory. (Older content from live streams will not be deleted.)'});
    parser.addArgument('-o', {default:'.', help: 'Output directory to use for caching the stream.'});
    parser.addArgument('--save-individual-mpds', {action:'storeTrue', help:'Saves each refreshed MPD in a separate file'});
    let args = parser.parseArgs();
    run(args);
}

if (require.main === module) {
    // called directly
    main();
} else {
    // required as a module
    var mpd = 'http://wbwwtvm.mfs.lvp.llnw.net/media/1dc1dfca7d3c41be8f3d429cf9014773/5381bd98254d4e378fd7205040b232b4/dash/termsofuse_v1.ism/termsofuse_v1.mpd';
    var proxy = new DashProxy(
        mpd,   //mpd
        'test',     //output_dir
        null,     //download
        null   //save_mpds
    );
    proxy.run();
}

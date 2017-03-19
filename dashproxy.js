const path = require('path');
const fs = require('fs');
const time = require('time');
const logging = require('log4js');
const argparse = require('argparse');
const request = require('request');
const elementtree = require('elementtree');
const mkdirp = require('mkdirp');

// Python-esque format
// replaces matching variables in brackets
// with their respective values
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

// create console logger
const logger = logging.getLogger('dash-proxy');

// dash namespace
const ns = {'mpd':'urn:mpeg:dash:schema:mpd:2011'};


class RepAddr extends Object {
    constructor(period_idx, adaptation_set_idx, representation_idx) {
        super(period_idx, adaptation_set_idx, representation_idx);
        this.period_idx = period_idx;
        this.adaptation_set_idx = adaptation_set_idx;
        this.representation_idx = representation_idx;
    }
    toString() {
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
        }
        return this.adaptation_set(rep_addr).find('SegmentTemplate');
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
		this.trace = this.trace.bind(this);
		this.debug = this.debug.bind(this);
		this.info = this.info.bind(this);
		this.log = this.log.bind(this);
		this.warn = this.warn.bind(this);
		this.error = this.error.bind(this);
		this.fatal = this.fatal.bind(this);
    }
	trace(msg) {
        this.logger.trace(msg);
    }
    debug(msg) {
        this.logger.debug(msg);
    }
    info(msg) {
        this.logger.info(msg);
    }
    log(msg) {
        this.logger.log(msg);
    }
    warn(msg) {
        this.logger.warn(msg);
    }
    error(msg) {
        this.logger.error(msg);
    }
    fatal(msg) {
        this.logger.fatal(msg);
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
        // this.info('Running dash proxy for stream %s. Output goes in %s', (this.mpd, this.output_dir));
		this.info('Running dash proxy for stream '+this.mpd+'. Output goes in '+this.output_dir);
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
                _logger.error(error);
            } else if (resp.status_code < 200 || resp.status_code >= 300) {
				_logger.warn('Cannot GET the MPD. Server returned '+resp.status_code+'. Retrying after '+retry_interval);
                this.refresh_mpd(retry_interval);
            } else {
				// create & save to dir
				_logger.debug('Creating output directory');
				mkdirp.sync(_output_dir);
				_logger.debug('Saving source MPD file');
				let mpdfile = 'manifest.'+inc+'.mpd';
		        let dest = path.join(_output_dir, mpdfile);

		        let fs = require('fs');
		        fs.writeFile(dest, body, function(err) {
		            if (err) {
		                _logger.error(err);
		            } else {
		                _logger.info(mpdfile+' saved.');
		            }
		        });

                elementtree.register_namespace('', ns['mpd']);

                let mpd = elementtree.parse(body);
                _handle_mpd_tree(mpd);
            }
        });
    }
    get_base_url(mpd) {

        let baseUrl = function (url) {
            let idx = url.lastIndexOf('/');
            if (idx >= 0) {
                return url.slice(0,idx+1);
            }
            return url;
        };

        let base_url = baseUrl(this.mpd);
        let location = mpd.find('Location');
        if (location !== null) {
            base_url = baseUrl(location.text);
        }

        let baseUrlNode = mpd.find('BaseUrl');
        if (baseUrlNode) {
            if (baseUrlNode.text.startswith('http://') || baseUrlNode.text.startswith('https://')) {
                base_url = baseUrl(baseUrlNode.text);
            } else {
                base_url += baseUrlNode.text;
            }
        }

        return base_url;
    }
    handle_mpd_tree(mpd) {
        let original_mpd = Object.assign(mpd);

        let periods = mpd.findall('Period');
        this.debug('mpd='+periods);
        this.debug('Found '+periods.length+' periods, choosing the 1st one');

        let period = periods[0];
        let adaptation_sets = period.findall('AdaptationSet');

        for (let [as_idx, adaptation_set] of adaptation_sets.entries()) {
            let representations = adaptation_set.findall('Representation');

            for (let [rep_idx, representation] of representations.entries()) {

				this.debug('Found representation with id ' + (!representation['attrib'] || !representation['attrib']['id'] ? 'UKN' : representation.attrib.id));

                let rep_addr = new RepAddr(0, as_idx, rep_idx);
                this.ensure_downloader(mpd, rep_addr);
            }
        }
        this.write_output_mpd(original_mpd);
        let minimum_update_period = (!mpd['attrib'] || !mpd['attrib']['minimumUpdatePeriod'] ? '' : mpd.attrib.minimumUpdatePeriod);
        if (minimum_update_period) {
            // TODO parse minimum_update_period
            this.refresh_mpd(10);   //after=10
        } else {
            this.info('VOD MPD. Nothing more to do. Stopping...');
        }
    }

    ensure_downloader(mpd, rep_addr) {
        if (rep_addr in this.downloaders) {
            this.debug('A downloader for ' + rep_addr.toString() + ' already started');
        } else {
            this.info('Starting a downloader for ' + rep_addr.toString());
            let downloader = new DashDownloader(this, rep_addr);
            this.downloaders[rep_addr] = downloader;

            downloader.handle_mpd(mpd, this.get_base_url(mpd));
        }
    }
    write_output_mpd(mpd) {
        this.info('Writing the updated MPD file');

        let content = elementtree.tostring(mpd, {'encoding':'utf-8'});

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
    }

    handle_mpd(mpd, base_url) {
        this.mpd_base_url = base_url;
        this.mpd = new MpdLocator(mpd);

        let rep = this.mpd.representation(this.rep_addr);
        let subdir = this.mpd.base_url(this.rep_addr);
		subdir = (subdir) ? subdir.text : null;

        this.debug('subdir = ' + subdir);
		let output_path = (subdir) ? path.join(this.proxy.output_dir, subdir) : this.proxy.output_dir;

		mkdirp.sync(output_path);
		this.debug('Created dir:', output_path);

        let segment_template = this.mpd.segment_template(this.rep_addr);
        let segment_timeline = this.mpd.segment_timeline(this.rep_addr);
        let initialization_template = (!segment_template['attrib'] || !segment_template['attrib']['initialization'] ? '' : segment_template.attrib.initialization); //

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
            let duration = Number( !segment['attrib'] || !segment['attrib']['d'] ? 0 : segment.attrib.d );
            let repeat = Number( !segment['attrib'] || !segment['attrib']['r'] ? 0 : segment.attrib.r );
            idx = idx + 1;
            for (let _ of range(0, repeat)) {
				// elem = elementtree.Element('{urn:mpeg:dash:schema:mpd:2011}S', attrib={'d':duration});
                elem = elementtree.Element('S', {'d':duration});
                segment_timeline.insert(idx, elem);
                this.debug('appding a new elem');
                idx = idx + 1;
            }
        }

        let media_template = (segment_template['attrib'] && segment_template['attrib']['media'] ? segment_template['attrib']['media'] : '');
        let next_time = 0;
        for (let segment of segment_timeline.findall('S')) {

			let _ctime = (!!segment.get('t')) ? segment.get('t') : -1;
            let current_time = Number(_ctime);
            if (current_time == -1) {
				segment['attrib'] = segment['attrib'] || {};
                segment['attrib']['t'] = next_time;
            } else {
                next_time = current_time;
            }
			let _time = (segment['attrib'] && segment['attrib']['d']) ? segment.attrib['d'] : 0;

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
			this.debug('creating folder path '+subfolders);
			mkdirp.sync(subfolders);
		}

        this.info('requesting '+dest);
		let _error = this.error.bind(this);
        let r = request.get(dest_url, function(error, resp, body) {
	        if (resp.statusCode >= 200 && resp.statusCode < 300) {
	            _write_file(dest, body);
	        } else {
	            _error('cannot download '+dest_url+'; server returned ' +resp.statusCode);

	        }
		});

    }

    render_template(template, representation=null, segment=null, subdir=null) {

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
			this.trace('representation is set');
        } else {
			this.trace('representation is null');
		}
        if (segment !== null) {
            args['time'] = (
				!segment['attrib'] || !segment['attrib']['t']
					? ''
					: segment.attrib['t']
				);
			this.trace('time is set');
        } else {
			this.trace('time is null');
		}
		template = format(template, args);
        return template;
    }

    full_url(dest) {
        return this.mpd_base_url + dest;
    }

    write_file(dest, content) {
		let _dest = dest;

		let _pos = dest.indexOf('?')==-1 ? dest.length : dest.indexOf('?');
        dest = dest.slice(0, _pos);
        dest = path.join(this.proxy.output_dir, dest);

		this.debug('Writing '+_dest);
		let _error = this.error.bind(this);
		let _info = this.info.bind(this);
        let fs = require('fs');
        fs.writeFile(dest, content, function(err) {
             if (err) {
                 _error(_dest+': Error writing file:', err);
             } else {
                 _info(_dest+': Write operation complete.');

             }
        });
    }
}

function run(args) {
    let _level = (!args.q) ? ((!args.v) ? 'INFO' : 'DEBUG') : 'ERROR';
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
	parser.addArgument('-q', {action:'storeTrue', help: 'Quiet mode. Will only log output if errors occur.'});
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

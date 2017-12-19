import * as fs from 'fs';
import * as path from 'path';
import * as extend from 'xtend';
import { noop } from './helpers';
import { get, resolveCandidates } from './item-manager';
import logger from './logger';

/**
 * Return a particular dashboard object
 *
 * @param  {string} dashboardFilePath dashboard path
 * @return {object} dashboard object
 */
function readDashboard(dashboardFilePath: any) {
  const dashboardConfig = JSON.parse(fs.readFileSync(dashboardFilePath).toString());

  if (!dashboardConfig.layout) {
    logger().error(`No layout field found in ${dashboardFilePath}`);
  }

  if (!dashboardConfig.layout.widgets) {
    logger().error(`No widgets field found in ${dashboardFilePath}`);
  }
  return dashboardConfig;
}

/**
 * Returns true if dashboard matches a particular regex filter
 *
 * @param  {string} dashboardFullPath dashboard full path
 * @param  {string} filter regex
 * @return {boolean}
 */
function matchDashboardFilter(dashboardFullPath: any, filter: any) {
  const dashboardName = path.basename(dashboardFullPath);
  return dashboardName.match(filter);
}

/**
 * Returns true if job matches a particular regex filter
 *
 * @param  {string} jobName job name
 * @param  {string} filter regex
 * @return {boolean}
 */
function matchJobFilter(jobName: any, filter: any) {
  return jobName.match(filter);
}

/**
 * Process all jobs from a dashboard
 *
 * @param  {array} allJobs all available jobs
 * @param  {string} dashboardName dashboard name
 * @param  {object} dashboardConfig dashboard config
 * @param  {object} filters filters, if any
 * @return {array} related jobs
 */
function processDashboard(allJobs: any, dashboardName: any, dashboardConfig: any, filters: any) {
  const jobs = [];
  for (let i = 0, l = dashboardConfig.layout.widgets.length; i < l; i += 1) {
    const jobItem = dashboardConfig.layout.widgets[i];
    if (jobItem.job) { // widgets can run without a job, displaying just static html.
      if (filters.jobFilter) {
        if (!matchJobFilter(jobItem.job, filters.jobFilter)) {
          continue;
        }
      }

      const candidateJobs = resolveCandidates(allJobs, jobItem.job, 'jobs', '.js');
      if (!candidateJobs.length) {
        logger().error(`
        ERROR RESOLVING JOB
        No job file found for "${jobItem.job}" in ${dashboardName}
        Have you pulled all the packages dependencies? (They are git submodules.)

        $ git submodule init
        $ git submodule update
        `);
      }

      const job: any = {
        configKey: jobItem.config,
        dashboard_name: path.basename(dashboardName, '.json'),
        job_name: jobItem.job,
        widget_item: jobItem,
      };
      const jobRequire = require(candidateJobs[0]);

      if (typeof jobRequire === 'function') {
        job.onRun = jobRequire;
      } else {
        job.onRun = jobRequire.onRun || noop;
        job.onInit = jobRequire.onInit || noop;
      }

      jobs.push(job);
    }
  }
  return jobs;
}

export default {
  /**
   * Return the jobs for all available dashboards in all the packages
   *
   * @param  {object}   options  options object
   * @param  {Function} callback
   */
  getJobs(options: any, callback: any) {

    const packagesPath = options.packagesPath;
    const filters = options.filters || {};

    const configPath = path.join(options.configPath, '/dashboard_common.json');
    let generalDashboardConfig: any = {};

    let jobs: any[] = [];

    // ----------------------------------------------
    // general config is optional, but if it exists it needs to be a valid file
    // ----------------------------------------------
    if (fs.existsSync(configPath)) {
      try {
        generalDashboardConfig = JSON.parse(fs.readFileSync(configPath).toString()).config;
        if (!generalDashboardConfig) {
          logger().error('invalid format. config property not found');
        }
      } catch (e) {
        return callback('ERROR reading general config file...' + configPath);
      }
    }

    // ----------------------------------------------
    // get all dashboards from all packages folder
    // ----------------------------------------------
    get(packagesPath, 'dashboards', '.json', (err: any, dashboardConfigFiles: any) => {
      if (err) {
        return callback(err);
      }

      // ----------------------------------------------
      // get all jobs from those packages
      // ----------------------------------------------
      get(packagesPath, 'jobs', '.js', (error: any, allJobs: any) => {
        if (error) {
          return callback(err);
        }

        for (let d = 0, dl = dashboardConfigFiles.length; d < dl; d += 1) {
          const dashboardName = dashboardConfigFiles[d];

          if (filters.dashboardFilter) {
            if (!matchDashboardFilter(dashboardName, filters.dashboardFilter)) {
              continue;
            }
          }

          let dashboardConfig: any;
          let dashboardJobs;
          try {
            dashboardConfig = readDashboard(dashboardName);
            dashboardJobs = processDashboard(allJobs, dashboardName, dashboardConfig, filters);
          } catch (error) {
            return callback(error);
          }

          // add config to job, extending for the same config key in general config, if any
          dashboardJobs = dashboardJobs.map((job) => {
            // Multiple configurations:
            //  local overrides global
            //  config n+1 overrides config n
            if (Array.isArray(job.configKey)) {
              const configs = job.configKey.map((key: any) => {
                return extend(
                  generalDashboardConfig[key],
                  dashboardConfig.config[key],
                );
              });
              job.config = extend.apply(null, configs);
            } else { // single configuration
              job.config = extend(
                generalDashboardConfig[job.configKey],
                dashboardConfig.config[job.configKey],
              );
            }

            return job;
          });

          jobs = jobs.concat(dashboardJobs);
        }

        callback(null, jobs);
      });
    });
  },
};

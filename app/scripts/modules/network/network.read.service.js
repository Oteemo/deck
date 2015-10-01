'use strict';

let angular = require('angular');

module.exports = angular
  .module('spinnaker.network.read.service', [
    require('exports?"restangular"!imports?_=lodash!restangular'),
    require('../utils/lodash.js'),
    require('../caches/infrastructureCaches.js')
  ])
  .factory('networkReader', function (Restangular, infrastructureCaches ) {

    function listNetworks() {
      return Restangular.one('networks')
        .withHttpConfig({cache: infrastructureCaches.networks})
        .get();
    }

    function listNetworksByProvider(cloudProvider) {
      return listNetworks().then(function(networks) {
        return networks[cloudProvider];
      });
    }

    return {
      listNetworks: listNetworks,
      listNetworksByProvider: listNetworksByProvider,
    };

  }).name;
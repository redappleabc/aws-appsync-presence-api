// Nodejs imports
import * as path from "path";

// CDK imports
import * as CDK from '@aws-cdk/core';
import * as EC2 from '@aws-cdk/aws-ec2';
import * as IAM from '@aws-cdk/aws-iam';
import * as ElastiCache from '@aws-cdk/aws-elasticache';
import * as Lambda from '@aws-cdk/aws-lambda';
import * as AppSync from '@aws-cdk/aws-appsync';
import * as AwsEvents from '@aws-cdk/aws-events';
import * as AwsEventsTargets from '@aws-cdk/aws-events-targets';

// Local imports
import { PresenceSchema } from './schema';
import { InterfaceVpcEndpointAwsService } from "@aws-cdk/aws-ec2";

// Interface used as parameter to create resolvers for our API
interface ResolverOptions {
  source: string | AppSync.BaseDataSource,
  requestMappingTemplate?: AppSync.MappingTemplate,
  responseMappingTemplate?: AppSync.MappingTemplate
}

/**
 * This is the main stack of our Application
 * 
 */
export class PresenceStack extends CDK.Stack {

  // Internal variables
  private vpc : EC2.Vpc;
  private lambdaSG : EC2.SecurityGroup;
  private redisCluster : ElastiCache.CfnReplicationGroup;
  private functions : { [key : string] : Lambda.Function } = {};
  private redisLayer : Lambda.LayerVersion;
  private redisPort : number = 6379;
  readonly api : AppSync.GraphqlApi;

  /**
   * Adds a Lambda Function to an internal list of functions indexed by their name.
   * The function code is assumed to be located in a subfolder related to that name 
   * and using `name.js` file as entry point.
   * 
   * All functions are using the "Redis Layer", containing a node module for Redis access,
   * as well as environment variables to access the Redis cluster.
   * 
   * The CDK Lambda.Code construct takes care of bundling the code (including local modules if any),
   * uploading it as Asset to S3.
   * 
   * @param name string: the name given to the function
   * @param useRedids boolean: whether the lambda uses redis or not, so it requires the layer and be in the VPC
   */
  private addFunction(name: string, useRedis: boolean = true) : void {
    const props = useRedis ? {
      vpc: this.vpc,
      vpcSubnets: this.vpc.selectSubnets({subnetGroupName: "Lambda"})
    } : {};
    const fn = new Lambda.Function(this, name, {
      ...props,
      code: Lambda.Code.fromAsset(path.resolve(__dirname, `../src/functions/${name}/`)),
      runtime: Lambda.Runtime.NODEJS_12_X,
      handler: `${name}.handler`,
      securityGroups: [this.lambdaSG]
    });
    // All lambdas will require access to redis
    useRedis && fn.addLayers(this.redisLayer);
    fn.addEnvironment("REDIS_HOST", this.redisCluster.attrPrimaryEndPointAddress);
    fn.addEnvironment("REDIS_PORT", this.redisCluster.attrPrimaryEndPointPort);
    this.functions[name] = fn;
  };

  /**
   * Retrieve one of the Lambda function by its name
   * 
   * @param name 
   */
  private getFn(name: string) : Lambda.Function {
    return this.functions[name];
  };

  /**
   * Helper function to create a resolver. A resolver attaches a Data Source to a specific field
   * in the schema. 
   * 
   * The ResolverOptions might also include request mapping and response mapping templates
   * 
   * @param typeName 
   * @param fieldName 
   * @param options ResolverOptions
   */
  private createResolver(typeName: string, fieldName: string, options: ResolverOptions)
    : AppSync.BaseDataSource {
    let source = (typeof(options.source) === 'string') ?
      this.api.addLambdaDataSource(`${options.source}DS`, this.getFn(options.source)) :
      options.source;
    source.createResolver({ typeName, fieldName, ...options });
    return source;
  };

  /**
   * Stack constructor
   * 
   * @param scope 
   * @param id 
   * @param props 
   */
  constructor(scope: CDK.Construct, id: string, props?: CDK.StackProps) {
    super(scope, id, props);

    /**
     * Network:
     * 
     * Here we define a VPC with two subnet groups.
     * The CDK automatically creates subnets in 3 different AZs by default
     * You can change the behavior using the `maxAzs` parameter.
     * 
     * Subnet types:
     * - ISOLATED to make sure the Redis Cluster is secured
     * - PRIVATE: used for the lambda function accessing Redis Cluster
     * - PUBLIC: required to add a Nat Gateway for Lambda to access AppSync.
     * 
     **/
    this.vpc = new EC2.Vpc(this, 'PresenceVPC', {
      cidr: "10.42.0.0/16",
      subnetConfiguration: [
        // Subnet group for Redis
        {
          cidrMask: 24,
          name: "Redis",
          subnetType: EC2.SubnetType.ISOLATED
        },
        // Subnet group for Lambda functions
        {
          cidrMask: 24,
          name: "Lambda",
          subnetType: EC2.SubnetType.ISOLATED
        }
      ]
    });
    // Add two different security groups:
    // One for the redis cluster, one for the lambda function.
    // This is to allow traffic only from our functions to the redis cluster
    const redisSG = new EC2.SecurityGroup(this, "redisSg", {
      vpc: this.vpc,
      description: "Security group for Redis Cluster"
    });
    this.lambdaSG = new EC2.SecurityGroup(this, "lambdaSg", {
      vpc: this.vpc,
      description: "Security group for Lambda functions"
    });
    redisSG.addIngressRule(
      this.lambdaSG,
      EC2.Port.tcp(this.redisPort)
    );

    /**
     * Redis cache cluster
     * Uses T3 small instances to start withs
     * 
     * Note those are level 1 constructs in CDK.
     * So props like `cacheSubnetGroupName` have misleading names and require a name 
     * in CloudFormation sense, which is actually a "ref" for reference.
     */
    const redisSubnets = new ElastiCache.CfnSubnetGroup(this, "RedisSubnets", {
      cacheSubnetGroupName: "RedisSubnets",
      description: "Subnet Group for Redis Cluster",
      subnetIds: this.vpc.selectSubnets({ subnetGroupName: "Redis"}).subnetIds
    });
    this.redisCluster = new ElastiCache.CfnReplicationGroup(this, "PresenceCluster", {
      replicationGroupDescription: "PresenceReplicationGroup",
      cacheNodeType: "cache.t3.small",
      engine: "redis",
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [redisSG.securityGroupId],
      port: this.redisPort
    });

    /**
     * Lambda functions
     * - Layer to add nodejs redis module
     */
    this.redisLayer = new Lambda.LayerVersion(this, "redisModule", {
      code: Lambda.Code.fromAsset(path.join(__dirname, '../src/layer/')),
      compatibleRuntimes: [Lambda.Runtime.NODEJS_12_X],
      layerVersionName: "presenceLayer"
    });
    // Use arrow function to keep "this" scope
    ['heartbeat','status','disconnect','timeout'].forEach((fn) => { this.addFunction(fn); });
    // On disconnect function is outside the VPC
    this.addFunction("on_disconnect", false);
    
    /**
     * The GraphQL API
     * 
     * Default authorization is set to use API_KEY. This is good for development and test,
     * in production, I would recommend using a COGNITO user based authentification.
     */
    this.api = new AppSync.GraphqlApi(this, "PresenceAPI", {
      name: "PresenceAPI",
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AppSync.AuthorizationType.API_KEY,
          apiKeyConfig: { name: "PresenceKey" }
        },
        additionalAuthorizationModes: [
          { authorizationType: AppSync.AuthorizationType.IAM }
        ]
      },
      schema: PresenceSchema(),
      logConfig: { fieldLogLevel: AppSync.FieldLogLevel.ALL }
    });
    // Configure sources and resolvers
    const heartbeatDS = this.createResolver("Query", "heartbeat", {source: "heartbeat"});
    this.createResolver("Query", "status", {source: "status"});
    this.createResolver("Mutation", "connect", {source: heartbeatDS} );
    this.createResolver("Mutation", "disconnect", {source: "disconnect"} );
    // None data source for list disconnection
    const noneDS = this.api.addNoneDataSource("disconnectedDS");
    const requestMappingTemplate = AppSync.MappingTemplate.fromString(`
      {
        "version": "2017-02-28",
        "payload": $util.toJson($context.arguments.id)
      }
    `);
    const responseMappingTemplate = AppSync.MappingTemplate.fromString(`
      $util.toJson($context.result)
    `);
    this.createResolver("Mutation", "disconnected", {
      source: noneDS,
      requestMappingTemplate,
      responseMappingTemplate
    });

    /**
     * Event bus
     * 
     */
    const presenceBus = new AwsEvents.EventBus(this, "PresenceBus");
    const timeoutFn = this.getFn("timeout");
    // Rule to trigger lambda check every minute
    new AwsEvents.Rule(this, "PresenceTimeoutRule", {
      schedule: AwsEvents.Schedule.cron({minute:"*"}),
      targets: [new AwsEventsTargets.LambdaFunction(timeoutFn)],
      enabled: true // Set to true in production
    });
    // Rule for disconnection event
    new AwsEvents.Rule(this, "PresenceDisconnectRule", {
      eventBus: presenceBus,
      description: "Rule for presence disconnection",
      eventPattern: {
        detailType: ["presence.disconnected"],
        source: ["api.presence"]
      },
      targets: [new AwsEventsTargets.LambdaFunction(this.getFn("on_disconnect"))],
      enabled: true
    });
    // Add an interface endpoint for EventBus
    const eventsEndPointSG = new EC2.SecurityGroup(this, "eventsEndPointSG", {
      vpc: this.vpc,
      description: "EventBrige interface endpoint SG"
    });
    eventsEndPointSG.addIngressRule(this.lambdaSG, EC2.Port.tcp(80));
    this.vpc.addInterfaceEndpoint("eventsEndPoint", {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_EVENTS,
      subnets: this.vpc.selectSubnets({subnetGroupName: "Lambda"}),
      securityGroups: [eventsEndPointSG]
    });
    
    /**
     * Complete configuration for lambda functions
     * 
     *  - Add environment variables to access api
     *  - Add IAM policy statement for GraphQL access
     *  - Add IAM policy statement for event bus access
     *  - Add the timeout
     *  - Configure triggering rule
     */
    
    timeoutFn.addEnvironment("TIMEOUT", "10000");
    timeoutFn.addEnvironment("EVENT_BUS", presenceBus.eventBusName);
    const allowEventBrige = new IAM.PolicyStatement({ effect: IAM.Effect.ALLOW });
    allowEventBrige.addActions("events:PutEvents");
    allowEventBrige.addResources(presenceBus.eventBusArn);
    timeoutFn.addToRolePolicy(allowEventBrige);
    this.getFn('disconnect').addToRolePolicy(allowEventBrige);

    const onDisconnectFn = this.getFn("on_disconnect");
    onDisconnectFn.addEnvironment("GRAPHQL_ENDPOINT", this.api.graphqlUrl);
    const allowAppsync = new IAM.PolicyStatement({ effect: IAM.Effect.ALLOW });
    allowAppsync.addActions("appsync:GraphQL");
    allowAppsync.addResources(this.api.arn);
    onDisconnectFn.addToRolePolicy(allowAppsync);

    /**
     * The CloudFormation stack output
     * 
     * Display the redis cache endpoints
     */
    new CDK.CfnOutput(this, "presence-api", {
      value: this.api.graphqlUrl,
      description: "Presence api endpoint",
      exportName: "presenceEndpoint"
    });
  }
}

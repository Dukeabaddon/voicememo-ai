import * as couchbase from 'couchbase';

const connectionString = process.env.COUCHBASE_CONNECTION_STRING || '';
const username = process.env.COUCHBASE_USERNAME || '';
const password = process.env.COUCHBASE_PASSWORD || '';
const bucketName = process.env.COUCHBASE_BUCKET || 'voicememo';
const scopeName = process.env.COUCHBASE_SCOPE || 'notes';
const collectionName = process.env.COUCHBASE_COLLECTION || 'entries';

let cluster: couchbase.Cluster | null = null;

export async function getCouchbase() {
  if (!cluster) {
    if (!connectionString || !username || !password) {
      throw new Error('Couchbase credentials missing in .env.local');
    }
    cluster = await couchbase.connect(connectionString, {
      username,
      password,
    });
  }

  const bucket = cluster.bucket(bucketName);
  const scope = bucket.scope(scopeName);
  const collection = scope.collection(collectionName);

  return { cluster, bucket, scope, collection };
}

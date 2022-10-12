import axios, { AxiosError, AxiosResponse } from 'axios';
import express, { Request, Response } from 'express';
import * as model from './database/model';
import { IComment, TypedRequestQuery, TypedRequestBody } from './interfaces';

declare var process : {
  env: {
    API_TOKEN1: string,
    API_TOKEN2: string,
    API_TOKEN3: string,
    API_URL: string
  }
};

let apiTokens: string[] = [
  process.env.API_TOKEN1,
  process.env.API_TOKEN2,
  process.env.API_TOKEN3
];

let tokenIndex = 0;

const router = express.Router();

const tryApi = function(req: Request, res: Response, depth=0) {
  if (depth === apiTokens.length) {
    res.status(500).send({message: 'Unable to retrieve comments from YouTube'});
    console.log('All API tokens are presumed to be spent up or invalid');
    return;
  }
  axios.get(`${process.env.API_URL}/search`, {
    params: {
      part: 'id',
      maxResults: 25,
      order: 'relevance',
      q: req.body.search,
      key: apiTokens[tokenIndex]
    }
  })
    .then((videoResults: AxiosResponse) => {
      // Get videos from yt API by search query
      let commentPromises: any[] = [];
      for (let item of videoResults.data.items) {
        commentPromises.push(
          // Get relevant comments from videos
          axios.get(`${process.env.API_URL}/commentThreads`, {
            params: {
              part: 'snippet',
              moderationStatus: 'published',
              order: 'relevance',
              maxResults: 100,
              videoId: item.id.videoId,
              key: apiTokens[tokenIndex]
            }
          })
            .catch((error: AxiosError) => null)
        );
      }
      return Promise.all(commentPromises);
    })
    .then((responsePromises: AxiosResponse[]) => {
      let comments: IComment[] = [];
      for (let response of responsePromises) {
        if (response !== null) {
          for (let comment of response.data.items) {
            comments.push(
              {
                _id: comment.id,
                username: comment.snippet.topLevelComment.snippet.authorDisplayName,
                userId: comment.snippet.topLevelComment.snippet.authorChannelId ? comment.snippet.topLevelComment.snippet.authorChannelId.value : 'N/A',
                text: comment.snippet.topLevelComment.snippet.textOriginal,
                likeCount: comment.snippet.topLevelComment.snippet.likeCount,
                videoId: comment.snippet.topLevelComment.snippet.videoId,
                search: req.body.search
              }
            )
          }
        }
      }
      if (!comments.length) {
        res.status(400).send({message: `Couldn't retrieve comments for search ${req.body.search}`});
        return;
      }
      model.saveComments(comments)
        .then(() => res.status(201).send({message: 'Search created'}))
        .catch((error: any) => {
          console.log('Error saving comments to database:', error);
          res.sendStatus(500);
        });
    })
    .catch((error: AxiosError) => {
      if ([403, 400].includes(error.response!.status)) {
        let token = '';
        let cycles = 1;
        while (token === '' && cycles < apiTokens.length) {
          if (tokenIndex < apiTokens.length - 1) {
            tokenIndex += 1;
          } else {
            tokenIndex = 0;
          }
          token = apiTokens[tokenIndex];
          cycles++;
          console.log('Presumed API token error, switching tokens');
        }
        tryApi(req, res, depth + 1); // Call itself recursively if 403, rather than send 500
      } else {
        console.log('Non-API token related error:', error);
        res.sendStatus(500);
      }
    })
}

type GetCommentsParams = {
  search: string,
  likeCount: number
}

// Get comments from db
// Expects from req.query:
  // search - Youtube search query from which to retrieve comments from the db
  // likeCount (optional) - Minimum number of likes a comment must receive to be returned in the query
// Works on partial matches i.e. 'zoo' will match for 'my day at the zoo' searches
// TypedRequestQuery is there solely for TS exercise
// router.get('/comments', (req: TypedRequestQuery<GetCommentsParams>, res) => {
router.get('/comments', (req, res) => {
  if (!req.query.search) {
    res.sendStatus(400);
    return;
  }
  model.getCommentsBySearchPartial(req.query.search as string, parseInt(req.query.likeCount as string) || -1)
    .then((results: IComment[]) => {
      if (!results.length) {
        res.status(404).send({message: `No comments match the given search "${req.query.search}"`});
        return;
      }
      let comments = results.map((result) => result.text);
      res.status(200).send({comments});
    })
    .catch((error: any) => {
      console.log('Error retrieving comments by search from database', error);
      res.sendStatus(500);
    });
});

// Get top comments for a search query from YT API, save to db
// Expects from req.body:
  // search - Youtube search query from which to retrieve comments from the API
// First submit the query to youtube API, get list of results
// From that list of results, get the top comments
// Save the top comments by url and search query
// Results will be returned by search query
// TODO: Add language filter on comment results
// router.post('/comments', (req: TypedRequestBody<{ search: string }>, res: Response) => {
router.post('/comments', (req, res) => {
  // console.log(req.body);
  // Search API for videos by query
  if (!req.body.search || typeof req.body.search !== 'string') {
    res.status(400).send({message: 'Missing required query parameters'});
    return;
  }
  req.body.search = req.body.search.toLowerCase();
  model.doesSearchExist(req.body.search)
    .then((response) => {
      if (response) { // If this search has been done already, don't bother contacting the API
        res.status(201).send({message: 'Search has been done previously'});
        return;
      }
      tryApi(req, res);
    })
    .catch((error: any) => {
      console.log('Error checking existence of search in database:', error);
      res.sendStatus(500);
    });

});

router.get('/searches', (req, res) => {
  model.getAllSearches()
    .then((searches: string[]) => res.status(200).send({searches}))
    .catch((error: any) => {
      console.log('Error retrieving searches from database:', error);
      res.status(404).send({message: 'Unable to retrieve search list'});
    });
});

export default router;
